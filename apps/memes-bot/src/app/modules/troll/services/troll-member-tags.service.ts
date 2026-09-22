import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { Bot } from 'grammy';
import { BaseConfigService } from '../../config/base-config.service';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import {
  TROLL_HISTORY_TTL_HOURS,
  TROLL_MEMBER_TAG_COOLDOWN_HOURS,
  TROLL_MEMBER_TAG_MAX_MESSAGES,
  TROLL_MEMBER_TAG_MAX_TOKENS,
  TROLL_MEMBER_TAG_MIN_MESSAGES,
  TROLL_MEMBER_TAG_TRANSCRIPT_CHARS,
  TROLL_MEMBER_TAGS_MAX_MEMBERS_PER_CHAT,
  TROLL_CONTEXT_MAX_TURNS,
} from '../constants/troll-limits';
import { MEMBER_TAG_PROMPT } from '../constants/troll-prompts';
import { TrollChatEntity } from '../entities/troll-chat.entity';
import { TrollMemberTagEntity } from '../entities/troll-member-tag.entity';
import { TrollMessageEntity } from '../entities/troll-message.entity';
import { MemberTagCandidate, MemberTagSuggestion } from '../interfaces/troll.interface';
import {
  sanitizeMemberTag,
  sanitizeModelText,
  sanitizeTranscript,
  wrapUserContent,
} from '../utils/troll-sanitizer';
import { DeepSeekService } from './deepseek.service';
import { TrollSettingsService } from './troll-settings.service';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Смешные теги участников чата по темам их сообщений.
 *
 * Раз в час обходит активные чаты, где бот — администратор с правом
 * `can_manage_tags`, собирает реплики участников за сутки (нужно больше одной),
 * просит модель придумать и отскорить теги-кандидаты и, если лучший тег
 * отличается от текущего, применяет `setChatMemberTag` и объявляет «нарекаю …».
 * Антифлуд: одному участнику меняем тег не чаще TROLL_MEMBER_TAG_COOLDOWN_HOURS.
 */
@Injectable()
export class TrollMemberTagsService {
  private readonly logger = new Logger(TrollMemberTagsService.name);

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
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

  /** Проверяет право бота и обрабатывает участников одного чата. */
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

    const byUser = new Map<number, TrollMessageEntity[]>();
    for (const row of rows) {
      if (row.userId == null) continue;
      const list = byUser.get(row.userId);
      if (list) list.push(row);
      else byUser.set(row.userId, [row]);
    }

    const candidates = [...byUser.entries()]
      .filter(([, list]) => list.length >= TROLL_MEMBER_TAG_MIN_MESSAGES)
      .slice(0, TROLL_MEMBER_TAGS_MAX_MEMBERS_PER_CHAT);
    if (!candidates.length) {
      return;
    }

    const admins = await this.adminIds(chatId);
    const stored = await this.tags.find({
      where: { chatId, userId: In(candidates.map(([userId]) => userId)) },
    });
    const storedByUser = new Map(stored.map((row) => [Number(row.userId), row]));

    for (const [userId, list] of candidates) {
      try {
        await this.processMember(chatId, userId, list, storedByUser.get(userId) ?? null, admins, now);
      } catch (error) {
        this.logger.warn(
          `Теги: чат ${chatId} участник ${userId} — сбой: ${this.describeError(error)}`
        );
      }
    }
  }

  /** Считает и применяет тег одному участнику. */
  private async processMember(
    chatId: number,
    userId: number,
    list: TrollMessageEntity[],
    stored: TrollMemberTagEntity | null,
    admins: Set<number>,
    now: Date
  ): Promise<void> {
    if (userId === this.config.ownerId || admins.has(userId)) {
      return;
    }
    if (stored && now.getTime() - new Date(stored.updatedAt).getTime() < TROLL_MEMBER_TAG_COOLDOWN_HOURS * HOUR_MS) {
      return;
    }

    const transcript = sanitizeTranscript(
      this.buildTranscript(list),
      TROLL_MEMBER_TAG_TRANSCRIPT_CHARS
    );
    if (!transcript) {
      return;
    }

    const suggestion = await this.deepSeek.completeJson<MemberTagSuggestion>(
      MEMBER_TAG_PROMPT,
      wrapUserContent(transcript),
      { temperature: 1, maxTokens: TROLL_MEMBER_TAG_MAX_TOKENS, label: 'теги' }
    );
    const best = this.pickBestTag(suggestion);
    if (!best) {
      this.logger.debug(`Теги: чат ${chatId} участник ${userId} — модель не дала тегов`);
      return;
    }
    if (stored?.tag === best.tag) {
      return;
    }

    const name = this.memberName(list[0]);
    await this.bot.api.setChatMemberTag(chatId, userId, best.tag);
    await this.announce(chatId, name, best.tag, best.reason, list[0]?.messageId ?? undefined);

    await this.tags.save({
      ...(stored ? { id: stored.id } : {}),
      chatId,
      userId,
      userName: name,
      tag: best.tag,
      reason: best.reason,
      topics: this.pickTopics(suggestion),
    });
    this.logger.log(`Теги: чат ${chatId} участник ${userId} наречён «${best.tag}»`);
  }

  /**
   * Собирает расшифровку реплик участника (хронологически), не превышая
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

  /** Выбирает лучшего кандидата: санитайз, отсев пустых, сортировка по скору. */
  private pickBestTag(suggestion: MemberTagSuggestion | null): MemberTagCandidate | null {
    const candidates = (suggestion?.tags ?? [])
      .map((candidate) => ({
        tag: sanitizeMemberTag(candidate?.tag),
        reason: sanitizeModelText(String(candidate?.reason ?? ''), 200),
        relevance: this.clampScore(candidate?.relevance),
      }))
      .filter((candidate) => candidate.tag.length > 0)
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

  /** Объявление о наречении — ответом на последнее сообщение участника. */
  private async announce(
    chatId: number,
    name: string,
    tag: string,
    reason: string,
    replyToMessageId?: number
  ): Promise<void> {
    const why = reason || 'ты сам всё понимаешь';
    const text = `нарекаю ${name} — ${tag}! потому что ${why}`;
    try {
      await this.bot.api.sendMessage(chatId, text, {
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });
    } catch (error) {
      this.logger.warn(`Теги: объявление в чат ${chatId} не ушло: ${this.describeError(error)}`);
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

  private async adminIds(chatId: number): Promise<Set<number>> {
    try {
      const admins = await this.bot.api.getChatAdministrators(chatId);
      return new Set(admins.map((member) => member.user.id));
    } catch (error) {
      this.logger.warn(
        `Теги: чат ${chatId} — не получить админов: ${this.describeError(error)}`
      );
      return new Set();
    }
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
