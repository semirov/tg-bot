import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Bot } from 'grammy';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import {
  TROLL_CONTEXT_MAX_TURNS,
  TROLL_HISTORY_TTL_HOURS,
  TROLL_MEMBER_TAG_ANNOUNCE_MAX_CHARS,
  TROLL_MEMBER_TAG_ANNOUNCE_MAX_TOKENS,
  TROLL_MEMBER_TAG_COOLDOWN_HOURS,
  TROLL_MEMBER_TAG_MAX_FIRST_PER_CHAT,
  TROLL_MEMBER_TAG_MAX_MESSAGES,
  TROLL_MEMBER_TAG_MAX_RENAMES_PER_CHAT,
  TROLL_MEMBER_TAG_MAX_TOKENS,
  TROLL_MEMBER_TAG_MIN_MESSAGES,
  TROLL_MEMBER_TAG_NEW_MESSAGES,
  TROLL_MEMBER_TAG_OCCUPIED_MAX,
  TROLL_MEMBER_TAG_TRANSCRIPT_CHARS,
} from '../constants/troll-limits';
import { MEMBER_TAG_ANNOUNCE_PROMPT, MEMBER_TAG_PROMPT } from '../constants/troll-prompts';
import { TrollChatEntity } from '../entities/troll-chat.entity';
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

/** Кандидат на наречение: свежие реплики и прежний тег (если был). */
interface TagCandidate {
  userId: number;
  fresh: TrollMessageEntity[];
  stored: TrollMemberTagEntity | null;
  newCount: number;
}

/**
 * Смешные теги участников чата по тому, как они общаются.
 *
 * Раз в час обходит активные чаты, где бот — администратор с правом
 * `can_manage_tags`, и меняет тег только «по делу»:
 * - впервые — если человек написал не меньше TROLL_MEMBER_TAG_MIN_MESSAGES сообщений;
 * - повторно — не чаще раза в сутки и только когда накопилось
 *   TROLL_MEMBER_TAG_NEW_MESSAGES новых реплик, не участвовавших в прошлом наречении.
 * За прогон в чате — не больше нескольких смен и первых наречений, чтобы не
 * разметить всех разом. Тег без мата и обзывательств; объявление генерирует модель.
 */
@Injectable()
export class TrollMemberTagsService {
  private readonly logger = new Logger(TrollMemberTagsService.name);

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly deepSeek: DeepSeekService,
    private readonly settings: TrollSettingsService,
    @InjectRepository(TrollChatEntity)
    private readonly chats: Repository<TrollChatEntity>,
    @InjectRepository(TrollMessageEntity)
    private readonly history: Repository<TrollMessageEntity>,
    @InjectRepository(TrollMemberTagEntity)
    private readonly tags: Repository<TrollMemberTagEntity>
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  public async refreshMemberTagsJob(): Promise<void> {
    await this.refreshMemberTags();
  }

  /** Обходит активные чаты и обновляет теги участников. */
  public async refreshMemberTags(now: Date = new Date()): Promise<void> {
    const s = this.settings.current;
    if (!s.enabled || !s.memberTagsEnabled) {
      return;
    }

    let activeChats: TrollChatEntity[];
    try {
      activeChats = await this.chats.find({ where: { isActive: true } });
    } catch (error) {
      this.logger.warn(`Теги: не удалось получить активные чаты: ${this.describeError(error)}`);
      return;
    }

    for (const chat of activeChats) {
      try {
        await this.processChat(Number(chat.chatId), now);
      } catch (error) {
        this.logger.warn(`Теги: чат ${chat.chatId} — сбой: ${this.describeError(error)}`);
      }
    }
  }

  /** Проверяет право бота, отбирает «заслуживших» и обрабатывает их. */
  private async processChat(chatId: number, now: Date): Promise<void> {
    if (!(await this.canManageTags(chatId))) {
      return;
    }

    const since = new Date(now.getTime() - TROLL_HISTORY_TTL_HOURS * HOUR_MS);
    const rows = await this.history.find({
      where: { chatId, role: 'user', createdAt: MoreThanOrEqual(since) },
      order: { id: 'DESC' },
      take: TROLL_CONTEXT_MAX_TURNS,
    });
    if (!rows.length) {
      return;
    }

    // bigint-поля Postgres отдаёт строками — приводим id к числу, иначе ключи
    // мапы не сойдутся с сохранёнными тегами и участник обработается повторно.
    const byUser = new Map<number, TrollMessageEntity[]>();
    for (const row of rows) {
      const userId = Number(row.userId);
      if (!Number.isFinite(userId)) continue;
      const list = byUser.get(userId);
      if (list) list.push(row);
      else byUser.set(userId, [row]);
    }

    const chatTags = await this.tags.find({ where: { chatId } });
    const storedByUser = new Map(chatTags.map((row) => [Number(row.userId), row]));
    // Создателю чата Telegram тег не меняет (CHAT_CREATOR_REQUIRED) — исключаем сразу,
    // чтобы он не занимал слот наречения.
    const creatorId = await this.chatCreatorId(chatId);

    const renames: TagCandidate[] = [];
    const firsts: TagCandidate[] = [];
    for (const [userId, list] of byUser) {
      if (userId === creatorId) {
        continue;
      }
      const stored = storedByUser.get(userId) ?? null;
      if (!stored) {
        // Первое наречение: только те, кто реально пишет, иначе разметим всех сразу.
        if (list.length >= TROLL_MEMBER_TAG_MIN_MESSAGES) {
          firsts.push({ userId, fresh: list, stored: null, newCount: list.length });
        }
        continue;
      }
      const lastEvaluatedAt = stored.lastEvaluatedAt
        ? new Date(stored.lastEvaluatedAt).getTime()
        : 0;
      if (now.getTime() - lastEvaluatedAt < TROLL_MEMBER_TAG_COOLDOWN_HOURS * HOUR_MS) {
        continue;
      }
      const cursor = Number(stored.lastMessageId ?? 0);
      const fresh = list.filter((row) => (row.id ?? 0) > cursor);
      if (fresh.length >= TROLL_MEMBER_TAG_NEW_MESSAGES) {
        renames.push({ userId, fresh, stored, newCount: fresh.length });
      }
    }

    // Сначала обновляем существующие теги (по объёму свежих реплик), потом — первые
    // наречения, и тех и других за прогон ограниченное число.
    const selected = [
      ...renames.sort((a, b) => b.newCount - a.newCount).slice(0, TROLL_MEMBER_TAG_MAX_RENAMES_PER_CHAT),
      ...firsts.sort((a, b) => b.newCount - a.newCount).slice(0, TROLL_MEMBER_TAG_MAX_FIRST_PER_CHAT),
    ];
    for (const item of selected) {
      const occupied = chatTags
        .filter((row) => Number(row.userId) !== item.userId && !!row.tag)
        .map((row) => row.tag as string);
      try {
        await this.processMember(chatId, item.userId, item.fresh, item.stored, occupied, now);
      } catch (error) {
        this.logger.warn(
          `Теги: чат ${chatId} участник ${item.userId} — сбой: ${this.describeError(error)}`
        );
      }
    }
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
      // Ответа нет — курсор не двигаем, попробуем в следующий прогон.
      this.logger.debug(`Теги: чат ${chatId} участник ${userId} — модель не дала тегов`);
      return;
    }

    const newestId = fresh[0]?.id ?? null;
    const name = this.memberName(fresh[0]);

    if (stored?.tag === best.tag) {
      // Тег тот же — просто отмечаем, что реплики «израсходованы» на оценку.
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

  /** id создателя чата: ему Telegram тег не меняет, поэтому пропускаем. */
  private async chatCreatorId(chatId: number): Promise<number | null> {
    try {
      const admins = await this.bot.api.getChatAdministrators(chatId);
      const creator = admins.find((member) => member.status === 'creator');
      return creator?.user.id ?? null;
    } catch (error) {
      this.logger.debug(
        `Теги: чат ${chatId} — не определить создателя: ${this.describeError(error)}`
      );
      return null;
    }
  }

  /** Бот — администратор с правом управления тегами? */
  private async canManageTags(chatId: number): Promise<boolean> {
    const botId = this.bot.botInfo?.id;
    if (!botId) {
      return false;
    }
    try {
      const me = await this.bot.api.getChatMember(chatId, botId);
      return me.status === 'administrator' && me.can_manage_tags === true;
    } catch (error) {
      this.logger.debug(`Теги: чат ${chatId} — не проверить права: ${this.describeError(error)}`);
      return false;
    }
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
