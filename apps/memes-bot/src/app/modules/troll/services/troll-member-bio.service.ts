import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import {
  TROLL_CONTEXT_MAX_TURNS,
  TROLL_HISTORY_TTL_HOURS,
  TROLL_MEMBER_BIO_CANARY,
  TROLL_MEMBER_BIO_INJECT_MAX_CHARS,
  TROLL_MEMBER_BIO_INJECT_MAX_USERS,
  TROLL_MEMBER_BIO_MAX_CHARS,
  TROLL_MEMBER_BIO_MAX_MESSAGES,
  TROLL_MEMBER_BIO_MAX_TOKENS,
  TROLL_MEMBER_BIO_MIN_INTERVAL_MS,
  TROLL_MEMBER_BIO_TRANSCRIPT_CHARS,
  TROLL_MEMBER_BIO_UPDATE_EVERY,
} from '../constants/troll-limits';
import { MEMBER_BIO_EXTRACT_PROMPT } from '../constants/troll-prompts';
import { TrollChatEntity } from '../entities/troll-chat.entity';
import { TrollMemberBioEntity, TrollMemberBioFact } from '../entities/troll-member-bio.entity';
import { TrollMessageEntity } from '../entities/troll-message.entity';
import { sanitizeTranscript, wrapUserContent } from '../utils/troll-sanitizer';
import { ExtractedFact, decayOnly, evidenceLooksCopied, mergeFacts, renderBioText, sanitizeMemoryText } from '../utils/troll-bio';
import { DeepSeekService } from './deepseek.service';
import { TrollSettingsService } from './troll-settings.service';

/** Готовый блок для впрыска в диалог: тело, canary и факты (для output-guard). */
export interface BioInjection {
  body: string;
  canary: string;
  facts: string[];
}

/**
 * Внутренние биографии участников (долгая память, per-chat).
 *
 * Раз в TROLL_MEMBER_BIO_UPDATE_EVERY новых реплик участника досье обновляется:
 * LLM извлекает устойчивые факты, код сливает их с ядром, применяет распад по
 * периоду полураспада и вымывает ослабшие. Участникам досье не показывается;
 * в диалог подмешивается только владельцу видимым способом через buildInjection.
 */
@Injectable()
export class TrollMemberBioService implements OnModuleInit {
  private readonly logger = new Logger(TrollMemberBioService.name);
  /** Счётчик реплик участника с прошлого обновления (в памяти). */
  private readonly counters = new Map<string, number>();
  /** Когда досье обновлялось в последний раз, мс (антифлуд). */
  private readonly lastRunAt = new Map<string, number>();
  /** Пары, досье которых сейчас обновляется — защита от гонок. */
  private readonly inFlight = new Set<string>();
  /** Сколько досье дособирать по истории за один прогон бэкфилла. */
  private static readonly BACKFILL_MAX_PER_RUN = 5;

  constructor(
    private readonly deepSeek: DeepSeekService,
    private readonly settings: TrollSettingsService,
    @InjectRepository(TrollMemberBioEntity)
    private readonly bios: Repository<TrollMemberBioEntity>,
    @InjectRepository(TrollMessageEntity)
    private readonly history: Repository<TrollMessageEntity>,
    @InjectRepository(TrollChatEntity)
    private readonly chats: Repository<TrollChatEntity>
  ) {}

  /**
   * После старта один раз дособираем досье по уже накопленной истории, чтобы не
   * ждать, пока участники напишут 20 новых реплик.
   */
  public onModuleInit(): void {
    const timer = setTimeout(() => void this.backfillBiosJob(), 20_000);
    timer.unref?.();
  }

  /** Вызывается на каждую реплику пользователя; раз в N реплик запускает обновление. */
  public async noteUserMessage(chatId: number, userId: number, userName?: string): Promise<void> {
    const s = this.settings.current;
    if (!s.enabled || !s.memberBioEnabled) {
      return;
    }
    const numericChatId = Number(chatId);
    const numericUserId = Number(userId);
    if (!Number.isFinite(numericChatId) || !Number.isFinite(numericUserId)) {
      return;
    }
    chatId = numericChatId;
    userId = numericUserId;
    const key = `${chatId}:${userId}`;
    if (!this.counters.has(key)) {
      this.counters.set(key, await this.countPending(chatId, userId));
    }
    const current = this.counters.get(key);
    const next = (current === undefined ? 0 : current) + 1;
    this.counters.set(key, next);
    if (next < TROLL_MEMBER_BIO_UPDATE_EVERY) {
      return;
    }
    const last = this.lastRunAt.get(key) ?? 0;
    if (Date.now() - last < TROLL_MEMBER_BIO_MIN_INTERVAL_MS) {
      return;
    }
    this.lastRunAt.set(key, Date.now());
    void this.refreshBio(chatId, userId, userName);
  }

  /** Сколько реплик пользователя ещё не учтено в досье (по курсору). */
  private async countPending(chatId: number, userId: number): Promise<number> {
    try {
      const bio = await this.bios.findOne({ where: { chatId, userId } });
      const cursor = Number(bio?.lastMessageId ?? 0);
      return await this.history.count({
        where: { chatId, userId, role: 'user', ...(cursor ? { id: MoreThan(cursor) } : {}) },
      });
    } catch (error) {
      this.logger.warn(`Био: не посчитать ожидающие реплики: ${this.describeError(error)}`);
      return 0;
    }
  }

  /** Обновляет досье участника: извлечение, слияние, распад, сохранение. */
  public async refreshBio(chatId: number, userId: number, userName?: string): Promise<void> {
    const key = `${chatId}:${userId}`;
    if (this.inFlight.has(key)) {
      return;
    }
    this.inFlight.add(key);
    try {
      const s = this.settings.current;
      if (!s.enabled || !s.memberBioEnabled) {
        return;
      }
      const bio = await this.bios.findOne({ where: { chatId, userId } });
      const cursor = Number(bio?.lastMessageId ?? 0);
      const rows = await this.history.find({
        where: { chatId, userId, role: 'user', ...(cursor ? { id: MoreThan(cursor) } : {}) },
        order: { id: 'ASC' },
        take: TROLL_MEMBER_BIO_MAX_MESSAGES,
      });
      if (!rows.length) {
        return;
      }

      const dossier = (bio?.facts ?? []).map((fact) => fact.text);
      const extracted = await this.extractFacts(userName ?? 'участник', dossier, rows);
      if (extracted === null) {
        // Модель не ответила — курсор не двигаем, попробуем позже.
        this.logger.debug(`Био: чат ${chatId} участник ${userId} — модель не ответила`);
        return;
      }

      const now = Date.now();
      const merged = mergeFacts(bio?.facts ?? [], extracted, now);
      const capped = this.capFacts(merged.facts, TROLL_MEMBER_BIO_MAX_CHARS);
      const newestId = rows[rows.length - 1].id;
      await this.bios.save({
        ...(bio ? { id: bio.id } : {}),
        chatId,
        userId,
        userName: userName ?? bio?.userName ?? null,
        facts: capped,
        lastMessageId: newestId,
        lastEvaluatedAt: new Date(now),
      });
      this.counters.set(key, 0);
      this.logger.log(
        `Био: чат ${chatId} участник ${userId} — фактов ${capped.length} (+${merged.added}, ядро +${merged.promoted}, вымыто ${merged.dropped})`
      );
    } catch (error) {
      this.logger.warn(`Био: чат ${chatId} участник ${userId} — сбой: ${this.describeError(error)}`);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async extractFacts(
    name: string,
    dossier: string[],
    rows: TrollMessageEntity[]
  ): Promise<ExtractedFact[] | null> {
    const transcript = sanitizeTranscript(
      rows
        .map((row, index) => `${index + 1}) ${(row.content ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim()}`)
        .join('\n'),
      TROLL_MEMBER_BIO_TRANSCRIPT_CHARS
    );
    const user = [
      `Участник: ${name}`,
      'Текущее досье:',
      dossier.length ? dossier.map((fact) => `- ${fact}`).join('\n') : '—',
      '',
      'Новые реплики участника:',
      transcript,
    ].join('\n');

    const parsed = await this.deepSeek.completeJson<{ facts?: unknown }>(
      MEMBER_BIO_EXTRACT_PROMPT,
      wrapUserContent(user),
      { temperature: 0.2, maxTokens: TROLL_MEMBER_BIO_MAX_TOKENS, label: 'био' }
    );
    if (parsed === null || !Array.isArray(parsed.facts)) {
      // Модель не ответила или ответ битый — курсор не двигаем.
      return null;
    }
    const raw = parsed.facts;
    return raw
      .map((item): ExtractedFact | null => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const record = item as { text?: unknown; importance?: unknown; self?: unknown; evidence?: unknown };
        const text = typeof record.text === 'string' ? record.text : '';
        const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : '';
        // Факт без подтверждения «человек сказал это о себе» не берём.
        // Доказательство из скопированного чужого текста (коллективное «мы») отсеиваем.
        if (record.self !== true || !evidence || !text || evidenceLooksCopied(evidence)) {
          return null;
        }
        const importance = Math.min(5, Math.max(1, Math.round(Number(record.importance) || 3)));
        return { text, importance };
      })
      .filter((fact): fact is ExtractedFact => fact !== null);
  }

  /** Оставляет столько фактов, сколько влезает в потолок символов. */
  private capFacts(facts: TrollMemberBioFact[], maxChars: number): TrollMemberBioFact[] {
    const kept: TrollMemberBioFact[] = [];
    let used = 0;
    for (const fact of facts) {
      const cost = fact.text.length + 3;
      if (used + cost > maxChars) {
        break;
      }
      kept.push(fact);
      used += cost;
    }
    return kept;
  }

  /**
   * Собирает блок внутренней памяти для диалога: досье адресата и собеседников.
   * Досье не показывается участникам — только подмешивается в промпт.
   */
  public async buildInjection(chatId: number, userIds: number[]): Promise<BioInjection | null> {
    const s = this.settings.current;
    if (!s.enabled || !s.memberBioEnabled || !userIds.length) {
      return null;
    }
    try {
      const rows = await this.bios.find({ where: { chatId, userId: In(userIds) } });
      if (!rows.length) {
        return null;
      }
      const byUser = new Map(rows.map((row) => [Number(row.userId), row]));
      const blocks: string[] = [];
      const facts: string[] = [];
      let used = 0;
      for (const userId of userIds) {
        const row = byUser.get(Number(userId));
        if (!row) {
          continue;
        }
        const rowFacts = row.facts ?? [];
        const rendered = renderBioText(rowFacts, TROLL_MEMBER_BIO_MAX_CHARS);
        if (!rendered) {
          continue;
        }
        const safeName = sanitizeMemoryText(row.userName ?? 'участник', 64) || 'участник';
        const block = `${safeName} (${Number(row.userId)}):\n${rendered}`;
        if (blocks.length >= TROLL_MEMBER_BIO_INJECT_MAX_USERS || used + block.length > TROLL_MEMBER_BIO_INJECT_MAX_CHARS) {
          break;
        }
        blocks.push(block);
        used += block.length;
        for (const fact of rowFacts) {
          facts.push(fact.text);
        }
      }
      if (!blocks.length) {
        return null;
      }
      return { body: blocks.join('\n'), canary: TROLL_MEMBER_BIO_CANARY, facts };
    } catch (error) {
      this.logger.warn(`Био: не собрать блок для чата ${chatId}: ${this.describeError(error)}`);
      return null;
    }
  }

  /** Досье чата для админ-просмотра владельцем. */
  public getChatBios(chatId: number): Promise<TrollMemberBioEntity[]> {
    return this.bios.find({ where: { chatId }, order: { updatedAt: 'DESC' } });
  }

  /**
   * Бэкфилл досье по накопленной истории: раз в 10 минут дособираем участников,
   * у которых накопилось ≥ UPDATE_EVERY необработанных реплик. Нужен, чтобы
   * досье появлялись сразу по истории, а не только после 20 новых сообщений.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  public async backfillBiosJob(): Promise<void> {
    const s = this.settings.current;
    if (!s.enabled || !s.memberBioEnabled) {
      return;
    }
    try {
      const chats = await this.chats.find({ where: { isActive: true } });
      const since = new Date(Date.now() - TROLL_HISTORY_TTL_HOURS * 60 * 60 * 1000);
      let processed = 0;
      for (const chat of chats) {
        if (processed >= TrollMemberBioService.BACKFILL_MAX_PER_RUN) {
          break;
        }
        const chatId = Number(chat.chatId);
        const rows = await this.history.find({
          where: { chatId, role: 'user', createdAt: MoreThanOrEqual(since) },
          order: { id: 'DESC' },
          take: TROLL_CONTEXT_MAX_TURNS,
        });
        if (!rows.length) {
          continue;
        }
        const bios = await this.bios.find({ where: { chatId } });
        const cursorByUser = new Map(
          bios.map((bio) => [Number(bio.userId), Number(bio.lastMessageId ?? 0)])
        );
        const pending = new Map<number, { count: number; name: string }>();
        for (const row of rows) {
          const userId = Number(row.userId);
          if (!Number.isFinite(userId) || (row.id ?? 0) <= (cursorByUser.get(userId) ?? 0)) {
            continue;
          }
          const entry = pending.get(userId) ?? { count: 0, name: row.userName ?? 'участник' };
          entry.count += 1;
          if (row.userName) {
            entry.name = row.userName;
          }
          pending.set(userId, entry);
        }
        const candidates = [...pending.entries()]
          .filter(([, value]) => value.count >= TROLL_MEMBER_BIO_UPDATE_EVERY)
          .sort((a, b) => b[1].count - a[1].count);
        for (const [userId, value] of candidates) {
          if (processed >= TrollMemberBioService.BACKFILL_MAX_PER_RUN) {
            break;
          }
          const key = `${chatId}:${userId}`;
          if (this.inFlight.has(key)) {
            continue;
          }
          const last = this.lastRunAt.get(key) ?? 0;
          if (Date.now() - last < TROLL_MEMBER_BIO_MIN_INTERVAL_MS) {
            continue;
          }
          this.lastRunAt.set(key, Date.now());
          await this.refreshBio(chatId, userId, value.name);
          processed += 1;
        }
      }
      if (processed) {
        this.logger.log(`Био: бэкфилл — обработано досье ${processed}`);
      }
    } catch (error) {
      this.logger.warn(`Био: бэкфилл не прошёл: ${this.describeError(error)}`);
    }
  }

  /** Часовой распад досье: ослабшие факты вымываются без обращения к модели. */
  @Cron(CronExpression.EVERY_HOUR)
  public async decayBiosJob(): Promise<void> {
    const s = this.settings.current;
    if (!s.enabled || !s.memberBioEnabled) {
      return;
    }
    try {
      const rows = await this.bios.find();
      const now = Date.now();
      for (const row of rows) {
        // Не перетираем досье, которое сейчас обновляется (гонка decay vs refresh).
        if (this.inFlight.has(`${Number(row.chatId)}:${Number(row.userId)}`)) {
          continue;
        }
        const { facts, dropped } = decayOnly(row.facts ?? [], now);
        if (dropped > 0) {
          await this.bios.update({ id: row.id }, { facts });
          this.logger.log(`Био: чат ${row.chatId} участник ${row.userId} — вымыто ${dropped} фактов`);
        }
      }
      this.pruneTriggerState(now);
    } catch (error) {
      this.logger.warn(`Био: распад не прошёл: ${this.describeError(error)}`);
    }
  }

  /** Чистит служебные карты триггера, чтобы они не росли бесконечно. */
  private pruneTriggerState(now: number): void {
    const ttl = TROLL_MEMBER_BIO_MIN_INTERVAL_MS * 6;
    for (const [key, at] of this.lastRunAt) {
      if (now - at > ttl) {
        this.lastRunAt.delete(key);
        this.counters.delete(key);
      }
    }
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
