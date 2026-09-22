import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import { Bot } from 'grammy';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import {
  TROLL_HISTORY_TTL_HOURS,
  TROLL_MEMBER_TAG_ANNOUNCE_MAX_CHARS,
  TROLL_MEMBER_TAG_ANNOUNCE_MAX_TOKENS,
  TROLL_MEMBER_TAG_BATCH_MESSAGES,
  TROLL_MEMBER_TAG_COOLDOWN_HOURS,
  TROLL_MEMBER_TAG_MAX_MESSAGES,
  TROLL_MEMBER_TAG_MAX_TOKENS,
  TROLL_MEMBER_TAG_OCCUPIED_MAX,
  TROLL_MEMBER_TAG_TRANSCRIPT_CHARS,
} from '../constants/troll-limits';
import { MEMBER_TAG_ANNOUNCE_PROMPT, MEMBER_TAG_PROMPT } from '../constants/troll-prompts';
import { TrollMemberTagEntity } from '../entities/troll-member-tag.entity';
import { TrollMessageEntity } from '../entities/troll-message.entity';
import { MemberTagCandidate, MemberTagSuggestion } from '../interfaces/troll.interface';
import {
  containsProfanity,
  sanitizeMemberTag,
  sanitizeModelText,
  sanitizeTranscript,
  toChatStyle,
  wrapUserContent,
} from '../utils/troll-sanitizer';
import { DeepSeekService } from './deepseek.service';
import { TrollSettingsService } from './troll-settings.service';

const HOUR_MS = 60 * 60 * 1000;
/** Как часто перепроверять права бота в чате, мс. */
const ACCESS_TTL_MS = 10 * 60 * 1000;

interface ChatAccess {
  ok: boolean;
  creatorId: number | null;
  at: number;
}

/**
 * Смешные теги участников — событийно, без крона.
 *
 * Триггер: на каждое TROLL_MEMBER_TAG_BATCH_MESSAGES-е сообщение участника
 * (10-е, 20-е, …). Контекст — вся история за сутки (TTL, без изменений).
 * На одного человека — не чаще раза в сутки. Ограничений на число наречений
 * в чате за день нет. Тег описывает манеру и мысли человека, без мата и
 * обзывательств; объявление генерирует отдельный промт. Создателя чата
 * пропускаем: Telegram не даёт менять ему тег (CHAT_CREATOR_REQUIRED).
 */
@Injectable()
export class TrollMemberTagsService {
  private readonly logger = new Logger(TrollMemberTagsService.name);
  private readonly chatAccess = new Map<number, ChatAccess>();

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly deepSeek: DeepSeekService,
    private readonly settings: TrollSettingsService,
    @InjectRepository(TrollMessageEntity)
    private readonly history: Repository<TrollMessageEntity>,
    @InjectRepository(TrollMemberTagEntity)
    private readonly tags: Repository<TrollMemberTagEntity>
  ) {}

  /**
   * Вызывается после сохранения сообщения пользователя. Раз в 10 реплик (и не
   * чаще раза в сутки на человека) пересматривает его тег.
   */
  public async onUserMessage(
    chatId: number,
    userId: number,
    now: Date = new Date()
  ): Promise<void> {
    const s = this.settings.current;
    if (!s.enabled || !s.memberTagsEnabled) {
      return;
    }

    // bigint-id может прийти строкой — нормализуем, иначе сравнения разъедутся.
    const uid = Number(userId);
    if (!Number.isFinite(uid)) {
      return;
    }

    const access = await this.chatAccessFor(chatId);
    if (!access.ok || uid === access.creatorId) {
      return;
    }

    const stored = await this.tags.findOne({ where: { chatId, userId: uid } });
    const cursor = Number(stored?.lastMessageId ?? 0);
    const since = new Date(now.getTime() - TROLL_HISTORY_TTL_HOURS * HOUR_MS);
    const where = {
      chatId,
      userId: uid,
      role: 'user',
      createdAt: MoreThanOrEqual(since),
      id: MoreThan(cursor),
    };

    const freshCount = await this.history.count({ where });
    if (
      freshCount < TROLL_MEMBER_TAG_BATCH_MESSAGES ||
      freshCount % TROLL_MEMBER_TAG_BATCH_MESSAGES !== 0
    ) {
      return;
    }
    if (
      stored?.lastEvaluatedAt &&
      now.getTime() - new Date(stored.lastEvaluatedAt).getTime() <
        TROLL_MEMBER_TAG_COOLDOWN_HOURS * HOUR_MS
    ) {
      return;
    }

    const fresh = await this.history.find({
      where,
      order: { id: 'DESC' },
      take: TROLL_MEMBER_TAG_MAX_MESSAGES,
    });
    if (!fresh.length) {
      return;
    }

    const chatTags = await this.tags.find({ where: { chatId } });
    const occupied = chatTags
      .filter((row) => Number(row.userId) !== uid && !!row.tag)
      .map((row) => row.tag as string);

    await this.processMember(chatId, uid, fresh, stored ?? null, occupied, now);
  }

  /** Считает и, если нужно, применяет новый тег участнику. */
  private async processMember(
    chatId: number,
    userId: number,
    fresh: TrollMessageEntity[],
    stored: TrollMemberTagEntity | null,
    occupiedTags: string[],
    now: Date
  ): Promise<void> {
    const transcript = sanitizeTranscript(
      this.buildTranscript(fresh),
      TROLL_MEMBER_TAG_TRANSCRIPT_CHARS
    );
    if (!transcript) {
      return;
    }

    const suggestion = await this.deepSeek.completeJson<MemberTagSuggestion>(
      this.systemPrompt(occupiedTags),
      wrapUserContent(transcript),
      { temperature: 1, maxTokens: TROLL_MEMBER_TAG_MAX_TOKENS, label: 'теги' }
    );
    const best = this.pickBestTag(suggestion);
    if (!best) {
      // Ответа нет — курсор не двигаем, попробуем на следующем десятке.
      this.logger.debug(`Теги: чат ${chatId} участник ${userId} — модель не дала тегов`);
      return;
    }

    const newestId = Number(fresh[0]?.id ?? 0) || null;
    const name = this.memberName(fresh[0]);

    if (stored?.tag === best.tag) {
      // Тег тот же — отмечаем реплики «израсходованными» на оценку.
      await this.tags.update(
        { id: stored.id },
        { lastEvaluatedAt: now, lastMessageId: newestId ?? stored.lastMessageId }
      );
      return;
    }

    await this.bot.api.setChatMemberTag(chatId, userId, best.tag);
    const announcement = await this.buildAnnouncement(name, best.tag, best.reason);
    await this.announce(chatId, announcement, fresh[0]?.messageId ?? undefined);

    await this.tags.save({
      ...(stored ? { id: stored.id } : {}),
      chatId,
      userId,
      userName: name,
      tag: best.tag,
      reason: best.reason,
      topics: this.pickTopics(suggestion),
      lastMessageId: newestId,
      lastEvaluatedAt: now,
    });
    this.logger.log(`Теги: чат ${chatId} участник ${userId} наречён «${best.tag}»`);
  }

  /**
   * Собирает расшифровку свежих реплик участника (хронологически), не превышая
   * потолок: при переполнении отбрасываем старое, а не свежее.
   */
  private buildTranscript(rowsNewestFirst: TrollMessageEntity[]): string {
    const lines: string[] = [];
    let used = 0;
    for (const row of rowsNewestFirst.slice(0, TROLL_MEMBER_TAG_MAX_MESSAGES)) {
      const text = (row.content ?? '').trim();
      if (!text) continue;
      const cost = text.length + 1;
      if (used + cost > TROLL_MEMBER_TAG_TRANSCRIPT_CHARS) break;
      lines.push(text);
      used += cost;
    }
    return lines.reverse().join('\n');
  }

  /** Выбирает лучшего кандидата: санитайз, отсев пустых и оскорбительных, сортировка по скору. */
  private pickBestTag(suggestion: MemberTagSuggestion | null): MemberTagCandidate | null {
    const candidates = (suggestion?.tags ?? [])
      .map((candidate) => ({
        tag: sanitizeMemberTag(candidate?.tag),
        reason: sanitizeModelText(String(candidate?.reason ?? ''), 200),
        relevance: this.clampScore(candidate?.relevance),
      }))
      .filter((candidate) => candidate.tag.length > 0 && !containsProfanity(candidate.tag))
      .sort((a, b) => b.relevance - a.relevance);
    return candidates[0] ?? null;
  }

  private pickTopics(suggestion: MemberTagSuggestion | null): string | null {
    const topics = (suggestion?.topics ?? [])
      .map((topic) => sanitizeModelText(String(topic), 40))
      .filter(Boolean)
      .slice(0, 5);
    return topics.length ? topics.join(', ') : null;
  }

  private clampScore(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(1, parsed));
  }

  private memberName(latest: TrollMessageEntity): string {
    const name = latest.userName?.trim();
    return name && name.length <= 64 ? name : 'участник';
  }

  /** Системный промпт со списком уже занятых в чате тегов (если есть). */
  private systemPrompt(occupied: string[]): string {
    const unique = [...new Set(occupied)].slice(0, TROLL_MEMBER_TAG_OCCUPIED_MAX);
    if (!unique.length) {
      return MEMBER_TAG_PROMPT;
    }
    return `${MEMBER_TAG_PROMPT}\n\nУже занятые теги в этом чате: ${unique.join(
      ', '
    )}. Не повторяй их и не делай слишком похожих.`;
  }

  /**
   * Объявление о наречении генерирует модель: коротко, матерно и смешно, но без
   * оскорблений. Если модель не ответила — уходим в детерминированный шаблон.
   */
  private async buildAnnouncement(name: string, tag: string, reason: string): Promise<string> {
    const payload = JSON.stringify({ имя: name, тег: tag, причина: reason });
    const raw = await this.deepSeek.completeText(
      MEMBER_TAG_ANNOUNCE_PROMPT,
      wrapUserContent(payload),
      { temperature: 1.05, maxTokens: TROLL_MEMBER_TAG_ANNOUNCE_MAX_TOKENS, label: 'наречение' }
    );
    const text = toChatStyle(sanitizeModelText(raw ?? '', TROLL_MEMBER_TAG_ANNOUNCE_MAX_CHARS));
    if (text) {
      return text;
    }
    const why = reason || 'ты сам всё понимаешь';
    return `нарекаю ${name} — ${tag}! потому что ${why}`;
  }

  /** Объявление о наречении — ответом на последнее учтённое сообщение участника. */
  private async announce(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });
    } catch (error) {
      this.logger.warn(`Теги: объявление в чат ${chatId} не ушло: ${this.describeError(error)}`);
    }
  }

  /** Права бота и id создателя чата (кэшируются на ACCESS_TTL_MS). */
  private async chatAccessFor(chatId: number): Promise<ChatAccess> {
    const cached = this.chatAccess.get(chatId);
    if (cached && Date.now() - cached.at < ACCESS_TTL_MS) {
      return cached;
    }

    let ok = false;
    let creatorId: number | null = null;
    const botId = this.bot.botInfo?.id;
    if (botId) {
      try {
        const me = await this.bot.api.getChatMember(chatId, botId);
        ok = me.status === 'administrator' && me.can_manage_tags === true;
      } catch (error) {
        this.logger.debug(`Теги: чат ${chatId} — не проверить права: ${this.describeError(error)}`);
      }
      if (ok) {
        try {
          const admins = await this.bot.api.getChatAdministrators(chatId);
          creatorId = admins.find((member) => member.status === 'creator')?.user.id ?? null;
        } catch (error) {
          this.logger.debug(
            `Теги: чат ${chatId} — не определить создателя: ${this.describeError(error)}`
          );
        }
      }
    }

    const access: ChatAccess = { ok, creatorId, at: Date.now() };
    this.chatAccess.set(chatId, access);
    return access;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
