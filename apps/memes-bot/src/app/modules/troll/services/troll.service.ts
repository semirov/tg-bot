import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Bot, InlineKeyboard } from 'grammy';
import type { ReactionTypeEmoji, User } from 'grammy/types';
import { Between, In, LessThan, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BOT } from '../../bot/providers/bot.provider';
import { BaseConfigService } from '../../config/base-config.service';
import { TROLL_CALLBACK_REGEXP, TrollCallbackEnum } from '../constants/troll-callback.enum';
import {
  TROLL_CONTEXT_MAX_CHARS,
  TROLL_CONTEXT_MAX_TURNS,
  TROLL_DEFECT_CONTEXT_CHARS,
  TROLL_DEFECT_CONTEXT_TURNS,
  TROLL_DEFECT_SEARCH_LIMIT,
  TROLL_DEFECT_SEVERITIES,
  TROLL_DEFECT_TIME_WINDOW_MS,
  TROLL_DIAGNOSTIC_MAX_TOKENS,
  TROLL_DIAGNOSTIC_MODEL,
  TROLL_FUTURE_ANGRY_AFTER,
  TROLL_FUTURE_AVOID_REPEAT,
  TROLL_FUTURE_COOLDOWN_HOURS,
  TROLL_FUTURE_GOOD_CHANCE,
  TROLL_FUTURE_MAX_CHARS,
  TROLL_HISTORY_MAX_CHARS,
  TROLL_HISTORY_TTL_HOURS,
  TROLL_JERK_MAX_TOKENS,
  TROLL_MAX_BATCH_MESSAGES,
  TROLL_MAX_CRIMINAL_REASON_CHARS,
  TROLL_MAX_CRIMINAL_TITLE_CHARS,
  TROLL_MAX_REPLY_CHARS,
  TROLL_MEME_COOLDOWN_SEC,
  TROLL_MEME_MAX_ATTEMPTS,
  TROLL_MEME_POOL_SIZE,
  TROLL_MIRROR_MIN_WORD_LEN,
  TROLL_SELF_CHECK_CONTEXT_CHARS,
  TROLL_SELF_CHECK_MAX_ATTEMPTS,
  TROLL_SELF_CHECK_MAX_TOKENS,
  TROLL_STAT_COOLDOWN_SEC,
  TROLL_STAT_MAX_CHARS,
  TROLL_STAT_MAX_MESSAGES_PER_USER,
  TROLL_SUMMARY_COOLDOWN_SEC,
  TROLL_SUMMARY_FALLBACK_MESSAGES,
  TROLL_SUMMARY_MAX_CHARS,
  TROLL_SUMMARY_MAX_MESSAGES,
  TROLL_SUMMARY_MAX_REPLY_CHARS,
  TROLL_SUMMARY_MAX_TOKENS,
} from '../constants/troll-limits';
import {
  CONVERSATION_PAUSE_RULE,
  CRIMINAL_ASSESSMENT_PROMPT,
  CRIMINAL_STAT_PROMPT,
  DEFECT_DIAGNOSTIC_PROMPT,
  FUTURE_ANGRY_PROMPT,
  FUTURE_BAD_PROMPT,
  FUTURE_GOOD_PROMPT,
  JERK_PROMPT,
  MEME_DENY_PROMPT,
  MIRROR_PROMPT,
  SARCASM_PROMPT,
  SELF_CHECK_PROMPT,
  SUMMARY_PROMPT,
  buildRetryNote,
  MESSAGE_REFS_RULE,
  TROLL_CAPABILITIES_REPLY,
  TROLL_FUTURE_TECHNIQUES,
  TROLL_MIRROR_INFIXES,
  TROLL_MIRROR_PREFIXES,
  TROLL_MIRROR_TECHNIQUES,
} from '../constants/troll-prompts';
import { isAddressedToBot, isCapabilityQuestion, isNamedCall } from '../constants/troll-addresses';
import { TrollChatEntity } from '../entities/troll-chat.entity';
import { TrollDefectEntity } from '../entities/troll-defect.entity';
import { TrollMessageEntity } from '../entities/troll-message.entity';
import { TrollPredictionEntity } from '../entities/troll-prediction.entity';
import { ChannelMemeEntity } from '../../channel-monitor/entities/channel-meme.entity';
import {
  CriminalAssessment,
  CriminalStat,
  DeepSeekMessage,
  TrollRuntimeSettings,
} from '../interfaces/troll.interface';
import {
  buildConversationContext,
  formatConversationPause,
  ConversationItem,
} from '../utils/troll-context';
import { DefectCandidate, normalizeMatchText, pickDefectAnswer } from '../utils/troll-defect';
import {
  containsLink,
  sanitizeModelField,
  sanitizeModelStyled,
  sanitizeModelText,
  sanitizeTranscript,
  sanitizeUserInput,
  toChatStyle,
  wrapUserContent,
} from '../utils/troll-sanitizer';
import { DeepSeekService } from './deepseek.service';
import { TrollCooldownRegistry } from './troll-cooldown-registry';
import { TrollNameRegistry } from './troll-name-registry';
import { MIN_TEXT_LENGTH, TrollReplyFormatter } from './troll-reply-formatter';
import { TrollSettingsService } from './troll-settings.service';

/** Как часто обновлять «печатает…», пока идёт накопление. */
const TYPING_REFRESH_MS = 4500;

/** Реакции-эмодзи, которые бот с шансом ставит на сообщения. */
const REACTION_EMOJIS = ['🤡', '💩'] as const;

/** Кому адресован ответ — для персонализации контекста. */
interface TrollFocus {
  userId?: number;
  userName?: string;
}

/** Накопленные обращения к боту, на которые он ответит одним сообщением. */
interface JerkBatch {
  texts: string[];
  users: Set<string>;
  /** Последний, кто обратился в этом окне — ему и отвечаем. */
  focusUserId?: number;
  focusUserName?: string;
  replyToMessageId?: number;
  /** Таймер дебаунса: каждое новое сообщение перезапускает его. */
  timer: ReturnType<typeof setTimeout>;
  /** Интервал, который держит индикатор «печатает…». */
  typingTimer: ReturnType<typeof setInterval>;
}

@Injectable()
export class TrollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrollService.name);

  /** Чаты, по которым уже идёт анализ — чтобы не плодить запросы к DeepSeek. */
  private readonly analyzingChats = new Set<number>();
  /** Последняя поставленная реакция по чату — чтобы эмодзи чередовались. */
  private readonly lastReactionEmoji = new Map<number, (typeof REACTION_EMOJIS)[number]>();
  /** Накопители обращений к боту по чатам. */
  private readonly jerkBatches = new Map<number, JerkBatch>();

  /** Реестр кулдаунов (карты `last*At`) — состояние и проверки вынесены. */
  private readonly cooldowns = new TrollCooldownRegistry();
  /** Реестр имён участников — восстановление регистра в ответах. */
  private readonly names = new TrollNameRegistry();
  /** Чистый форматтер текстов тролля. */
  private readonly formatter = new TrollReplyFormatter();

  /** Время последней проверки по УК РФ в чате (мс) — совместимое представление реестра. */
  private get lastAnalysisAt(): Map<number, number> {
    return this.cooldowns.lastAnalysisAt;
  }

  /** Время последнего случайного подкола в чате (мс) — совместимое представление реестра. */
  private get lastSarcasmAt(): Map<number, number> {
    return this.cooldowns.lastSarcasmAt;
  }

  /** Время последнего кривляния в чате (мс) — совместимое представление реестра. */
  private get lastMirrorAt(): Map<number, number> {
    return this.cooldowns.lastMirrorAt;
  }

  /** Время последней реакции-эмодзи в чате (мс) — совместимое представление реестра. */
  private get lastReactionAt(): Map<number, number> {
    return this.cooldowns.lastReactionAt;
  }

  /** Время последнего /stat (мс; ключ chatId:userId) — совместимое представление реестра. */
  private get lastStatAt(): Map<string, number> {
    return this.cooldowns.lastStatAt;
  }

  /** Время последнего ответа на кличку/мат (мс) — совместимое представление реестра. */
  private get lastJerkAnswerAt(): Map<number, number> {
    return this.cooldowns.lastJerkAnswerAt;
  }

  /** Время последнего /meme (мс; ключ chatId:userId) — совместимое представление реестра. */
  private get lastMemeAt(): Map<string, number> {
    return this.cooldowns.lastMemeAt;
  }

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
    private readonly deepSeek: DeepSeekService,
    private readonly settings: TrollSettingsService,
    @InjectRepository(TrollChatEntity)
    private readonly chats: Repository<TrollChatEntity>,
    @InjectRepository(TrollMessageEntity)
    private readonly history: Repository<TrollMessageEntity>,
    @InjectRepository(TrollPredictionEntity)
    private readonly predictions: Repository<TrollPredictionEntity>,
    @InjectRepository(TrollDefectEntity)
    private readonly defects: Repository<TrollDefectEntity>,
    @InjectRepository(ChannelMemeEntity)
    private readonly memes: Repository<ChannelMemeEntity>
  ) {}

  public onModuleInit(): void {
    // Команда /stat — персональные «сроки» за сутки по истории чата.
    this.bot.command('stat', async (ctx) => {
      try {
        await this.onStatCommand(ctx);
      } catch (error) {
        this.logger.error('Failed to handle /stat', error);
      }
    });

    // Команда /future — предсказание на день (кэш 12 часов).
    this.bot.command('future', async (ctx) => {
      try {
        await this.onFutureCommand(ctx);
      } catch (error) {
        this.logger.error('Failed to handle /future', error);
      }
    });

    // Команда /meme — репост случайного живого мема из канала (раз в час).
    this.bot.command('meme', async (ctx) => {
      try {
        await this.onMemeCommand(ctx);
      } catch (error) {
        this.logger.error('Failed to handle /meme', error);
      }
    });

    // Команда /sumarize — пересказ переписки с прошлого запроса (раз в час на чат).
    this.bot.command(['sumarize', 'summarize'], async (ctx) => {
      try {
        await this.onSummaryCommand(ctx);
      } catch (error) {
        this.logger.error('Failed to handle /sumarize', error);
      }
    });

    // Бота добавили/убрали из чата.
    this.bot.on('my_chat_member', async (ctx, next) => {
      try {
        await this.onMyChatMember(ctx);
      } catch (error) {
        this.logger.error('Failed to handle my_chat_member', error);
      }
      await next();
    });

    // Сообщения в группах.
    this.bot.on('message', async (ctx, next) => {
      try {
        await this.onMessage(ctx);
      } catch (error) {
        this.logger.error('Failed to handle troll message', error);
      }
      await next();
    });

    // Подтверждение/отклонение владельцем.
    this.bot.callbackQuery(TROLL_CALLBACK_REGEXP, async (ctx, next) => {
      try {
        await this.onOwnerDecision(ctx);
      } catch (error) {
        this.logger.error('Failed to handle troll owner decision', error);
      }
      await next();
    });

    // Вычищаем историю старше TTL один раз при старте (далее — по крону раз в час):
    // беседу помним 24 часа целиком, но старое не копим, чтобы контекст не утонул.
    void this.cleanupHistory();
  }

  public onModuleDestroy(): void {
    for (const batch of this.jerkBatches.values()) {
      clearTimeout(batch.timer);
      clearInterval(batch.typingTimer);
    }
    this.jerkBatches.clear();
  }

  /**
   * Вызывается после публикации мема в основной канал.
   * С заданной вероятностью бот **репостит** пост в активные чаты.
   * Работает круглосуточно.
   */
  public async maybeRepostMeme(channelId: number, messageId: number): Promise<void> {
    try {
      const s = this.settings.current;
      if (!s.enabled || !s.memeAnnounceEnabled) {
        this.logger.debug('Репост мема: пропуск — репосты выключены');
        return;
      }

      if (Math.random() >= s.memeAnnounceChance) {
        this.logger.debug(
          `Репост мема: пропуск — не повезло (шанс ${this.pct(s.memeAnnounceChance)})`
        );
        return;
      }

      const chats = await this.chats.find({ where: { isActive: true } });
      if (!chats.length) {
        this.logger.debug('Репост мема: нет активных чатов');
        return;
      }

      this.logger.log(`Репост мема: рассылаю в ${chats.length} чат(ов)`);

      let sent = 0;
      for (const chat of chats) {
        const chatId = Number(chat.chatId);
        try {
          await this.repostMeme(chatId, String(channelId), messageId);
          sent += 1;
        } catch (error) {
          this.logger.warn(
            `${this.tag(chatId)}: репост мема не удался — ${this.describeError(error)}`
          );
        }
      }

      this.logger.log(`Репост мема: отправлено в ${sent}/${chats.length} чат(ов)`);
    } catch (error) {
      this.logger.error('Failed to repost meme', error);
    }
  }

  /** Список всех известных чатов (для админки). */
  public getAllChats(): Promise<TrollChatEntity[]> {
    return this.chats.find({ order: { createdAt: 'DESC' } });
  }

  /** Включает/выключает работу бота в конкретном чате. */
  public async setChatActive(chatId: number | string, isActive: boolean): Promise<void> {
    await this.chats.update({ chatId: Number(chatId) }, { isActive });
  }

  private async onMessage(ctx: BotContext): Promise<void> {
    const chat = ctx.chat;

    // В личке у тролля один сценарий: владелец присылает ответ бота на разбор.
    if (chat?.type === 'private') {
      await this.onPrivateMessage(ctx);
      return;
    }

    // Работаем только в группах и только для реальных пользователей.
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }
    if (!ctx.from || ctx.from.is_bot || !ctx.message) {
      return;
    }

    const s = this.settings.current;
    if (!s.enabled) {
      this.logger.debug(`${this.tag(chat.id, ctx.from.id)}: тролль выключен — пропуск`);
      return;
    }

    if (!(await this.isChatActive(chat.id))) {
      this.logger.debug(`${this.tag(chat.id, ctx.from.id)}: чат не активен — пропуск`);
      return;
    }

    const content = ctx.message.text ?? ctx.message.caption ?? null;
    const text = content?.trim() ?? '';

    // Команды не анализируем.
    if (text.startsWith('/')) {
      this.logger.debug(`${this.tag(chat.id, ctx.from.id)}: команда — пропуск`);
      return;
    }

    const botId = ctx.me.id;
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === botId;
    const isMention = this.isBotMentioned(ctx, content);
    const isNameCall = s.addressReactionEnabled && isAddressedToBot(content);

    // Тип нетекстового контента (сам контент не храним — только пометку).
    const mediaKind = this.describeMediaKind(ctx.message);
    const hasLink = containsLink(text) || this.messageHasLink(ctx.message);

    // Запоминаем реплику для контекста диалога (хранится ограниченное время).
    // Текст храним как текст, медиа — только пометкой типа, ссылки — без URL.
    const entry = this.buildHistoryEntry(text, mediaKind, hasLink, s.maxInputChars);

    // Номер сообщения и то, на что отвечали: по ним видно связи в беседе.
    const refs = this.describeMessageRefs(
      ctx.message.message_id,
      ctx.message.reply_to_message?.message_id
    );
    // Текст сообщения пишем в лог: без него поведение бота не разобрать.
    this.logger.log(
      `${this.tag(chat.id, ctx.from.id)}: сообщение${refs} (длина ${text.length}, подпись=${
        ctx.message.text === undefined && content !== null
      }, тип=${mediaKind ?? (hasLink ? 'ссылка' : 'текст')}, реплайБоту=${isReplyToBot}, упоминание=${isMention}, обращениеПоСлову=${isNameCall}) ${this.logText(entry ?? '')}`
    );

    if (entry) {
      await this.remember(chat.id, 'user', entry, {
        userId: ctx.from?.id,
        userName: this.describeUser(ctx.from),
        messageId: ctx.message?.message_id,
        replyToMessageId: ctx.message?.reply_to_message?.message_id,
      });
    }

    // Вопрос «что ты умеешь» — рассказываем о себе и командах (без LLM).
    if (isCapabilityQuestion(content)) {
      this.logger.log(`${this.tag(chat.id, ctx.from.id)}: запрос возможностей — отвечаю списком команд`);
      const sentId = await this.safeReply(ctx, TROLL_CAPABILITIES_REPLY, false);
      await this.remember(chat.id, 'assistant', TROLL_CAPABILITIES_REPLY, {
        messageId: sentId ?? undefined,
        replyToMessageId: ctx.message?.message_id,
      });
      return;
    }

    // Просьба о рецепте — отшиваем грубо и шлём в поиск (правило в промпте).

    // Иногда просто реагируем эмодзи (🤡/💩), без ответа.
    this.maybeReact(ctx, s);

    // Обращение к боту (ответ/упоминание/кличка/мат) — копим и отвечаем одной репликой.
    if (s.jerkEnabled && (isReplyToBot || isMention || isNameCall)) {
      if (this.canAnswerJerk(chat.id, isReplyToBot || isMention || isNamedCall(content), s)) {
        this.enqueueJerk(ctx, content, s);
        return;
      }
    }

    if (text.length < MIN_TEXT_LENGTH) {
      this.logger.debug(`${this.tag(chat.id, ctx.from.id)}: слишком короткое — пропуск`);
      return;
    }

    // Проверка на признаки состава преступления (в фоне, чтобы не тормозить чат).
    if (s.criminalEnabled) {
      void this.checkCriminalArticle(ctx, text, s);
    }

    // Редкий язвительный подкол или кривляние (с кулдауном на чат).
    const mirrorWord = s.mirrorEnabled ? this.pickMirrorWord(chat.id, text, s) : null;
    if (mirrorWord) {
      void this.generateMirror(ctx, mirrorWord, s);
    } else if (s.sarcasmEnabled && !this.jerkBatches.has(chat.id)) {
      void this.replyWithSarcasm(ctx, s);
    }
  }

  private async checkCriminalArticle(
    ctx: BotContext,
    text: string,
    s: TrollRuntimeSettings
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    // Не плодим параллельные запросы и соблюдаем кулдаун на чат.
    if (this.analyzingChats.has(chatId)) {
      this.logger.debug(`${this.tag(chatId)}: проверка УК уже идёт — пропуск`);
      return;
    }
    if (this.withinCooldown(this.lastAnalysisAt, chatId, s.analyzeCooldownSec)) {
      const last = this.lastAnalysisAt.get(chatId) ?? Date.now();
      const remainSec = Math.max(
        0,
        Math.ceil((s.analyzeCooldownSec * 1000 - (Date.now() - last)) / 1000)
      );
      this.logger.debug(`${this.tag(chatId)}: проверка УК на паузе (ещё ~${remainSec}с) — пропуск`);
      return;
    }

    this.analyzingChats.add(chatId);
    this.lastAnalysisAt.set(chatId, Date.now());

    try {
      const cleaned = sanitizeUserInput(text, s.maxInputChars);
      if (!cleaned) {
        return;
      }

      this.logger.log(`${this.tag(chatId)}: проверяю по УК (длина ${cleaned.length})`);

      const assessment = await this.deepSeek.completeJson<CriminalAssessment>(
        CRIMINAL_ASSESSMENT_PROMPT,
        wrapUserContent(cleaned),
        { temperature: 0.2, maxTokens: 1000, label: 'статья-ук' }
      );

      if (!assessment || typeof assessment.probability !== 'number') {
        this.logger.warn(`${this.tag(chatId)}: проверка УК — пустой/битый ответ модели`);
        return;
      }

      const probability = Math.max(0, Math.min(1, assessment.probability));
      if (probability < s.criminalThreshold) {
        this.logger.log(
          `${this.tag(chatId)}: УК вероятность ${this.pct(probability)} < порога ${this.pct(
            s.criminalThreshold
          )} — молчу`
        );
        return;
      }

      this.logger.log(
        `${this.tag(chatId)}: УК вероятность ${this.pct(probability)} ≥ порога ${this.pct(
          s.criminalThreshold
        )} — отвечаю статьёй (статей: ${assessment.articles?.length ?? 0})`
      );

      const criminalReply = this.buildCriminalReply(assessment, probability, s);
      const sentId = await this.safeReply(ctx, criminalReply, true);
      await this.remember(chatId, 'assistant', sanitizeModelText(criminalReply, TROLL_HISTORY_MAX_CHARS), {
        messageId: sentId ?? undefined,
        replyToMessageId: ctx.message?.message_id,
      });
    } finally {
      this.analyzingChats.delete(chatId);
    }
  }

  /** Может ли бот ответить на такое обращение (прямые обращения — всегда). */
  private canAnswerJerk(
    chatId: number,
    explicit: boolean,
    s: TrollRuntimeSettings
  ): boolean {
    if (explicit) {
      return true;
    }
    if (this.withinCooldown(this.lastJerkAnswerAt, chatId, s.jerkCooldownSec)) {
      // Кличка/мат вообще — не обязательно в адрес бота. Если только что отвечали,
      // пропускаем как обычное сообщение, чтобы бот не забивал чат.
      this.logger.debug(`${this.tag(chatId)}: кличка/мат, но пауза ответов — пропуск`);
      return false;
    }
    return true;
  }

  /**
   * Копит обращения к боту и отвечает на все сразу после паузы (дебаунс):
   * каждое новое сообщение откладывает ответ ещё на окно. Пока идёт
   * накопление — держим в чате индикатор «печатает…».
   */
  private enqueueJerk(ctx: BotContext, content: string | null, s: TrollRuntimeSettings): void {
    const chatId = ctx.chat.id;
    const cleaned = sanitizeUserInput(content ?? '(без текста)', s.maxInputChars);
    const user = this.describeUser(ctx.from);

    const existing = this.jerkBatches.get(chatId);
    if (existing) {
      if (existing.texts.length < TROLL_MAX_BATCH_MESSAGES) {
        existing.texts.push(cleaned);
      } else {
        this.logger.warn(
          `${this.tag(chatId, ctx.from?.id)}: батч достиг лимита ${TROLL_MAX_BATCH_MESSAGES} — лишние не добавляю`
        );
      }
      existing.users.add(user);
      existing.focusUserId = ctx.from?.id;
      existing.focusUserName = user;
      existing.replyToMessageId = ctx.message?.message_id ?? existing.replyToMessageId;
      // Дебаунс: новое сообщение продлевает окно ещё на windowSec.
      clearTimeout(existing.timer);
      existing.timer = this.scheduleJerkFlush(chatId, s.jerkBatchWindowSec);
      this.logger.log(
        `${this.tag(chatId, ctx.from?.id)}: обращение к боту — в батче ${existing.texts.length}, дебаунс продлён на ${s.jerkBatchWindowSec}с`
      );
      return;
    }

    // Окно 0 — отвечаем сразу, без накопления.
    if (s.jerkBatchWindowSec <= 0) {
      this.logger.log(`${this.tag(chatId, ctx.from?.id)}: обращение к боту — отвечаю сразу (пауза 0)`);
      void this.replyAsJerk(ctx);
      return;
    }

    this.jerkBatches.set(chatId, {
      texts: [cleaned],
      users: new Set([user]),
      focusUserId: ctx.from?.id,
      focusUserName: user,
      replyToMessageId: ctx.message?.message_id,
      timer: this.scheduleJerkFlush(chatId, s.jerkBatchWindowSec),
      typingTimer: this.startTyping(chatId),
    });
    this.logger.log(
      `${this.tag(chatId, ctx.from?.id)}: обращение к боту — начинаю копить, отвечу после ${s.jerkBatchWindowSec}с тишины`
    );
  }

  /** Планирует ответ через windowSec (используется и для дебаунса). */
  private scheduleJerkFlush(chatId: number, windowSec: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.flushJerk(chatId, windowSec);
    }, Math.max(1, windowSec) * 1000);
    timer.unref?.();
    return timer;
  }

  /** Включает индикатор «печатает…» и периодически обновляет его. */
  private startTyping(chatId: number): ReturnType<typeof setInterval> {
    void this.sendTyping(chatId);
    const interval = setInterval(() => void this.sendTyping(chatId), TYPING_REFRESH_MS);
    interval.unref?.();
    return interval;
  }

  private async sendTyping(chatId: number): Promise<void> {
    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch {
      // Индикатор не критичен — ошибки (нет прав, чат недоступен) игнорируем.
    }
  }

  /** Отправляет накопленные обращения в модель и одной репликой отвечает в чат. */
  private async flushJerk(chatId: number, windowSec: number): Promise<void> {
    const batch = this.jerkBatches.get(chatId);
    this.jerkBatches.delete(chatId);
    if (!batch) {
      return;
    }

    clearTimeout(batch.timer);
    clearInterval(batch.typingTimer);

    const s = this.settings.current;
    if (!s.enabled) {
      this.logger.debug(`${this.tag(chatId)}: тролль выключен — батч сброшен без ответа`);
      return;
    }

    // Чат могли отключить, пока копилось окно.
    if (!(await this.isChatActive(chatId))) {
      this.logger.debug(`${this.tag(chatId)}: чат не активен — батч сброшен без ответа`);
      return;
    }

    this.logger.log(
      `${this.tag(chatId)}: тишина ${windowSec}с — формирую ответ на ${batch.texts.length} сообщ. от ${batch.users.size} польз.`
    );

    // Держим «печатает…», пока генерируется ответ.
    void this.sendTyping(chatId);

    const reply = await this.generateCheckedReply(
      JERK_PROMPT,
      chatId,
      { maxTokens: TROLL_JERK_MAX_TOKENS, temperature: 1.05, label: 'диалог' },
      { userId: batch.focusUserId, userName: batch.focusUserName },
      (raw) =>
        this.restoreNames(chatId, toChatStyle(sanitizeModelText(raw, TROLL_MAX_REPLY_CHARS)))
    );

    if (!reply) {
      this.logger.warn(`${this.tag(chatId)}: пустой ответ модели — не отправляю`);
      return;
    }

    const sentId = await this.safeSendToChat(chatId, reply, batch.replyToMessageId);
    await this.remember(chatId, 'assistant', reply, {
      messageId: sentId ?? undefined,
      replyToMessageId: batch.replyToMessageId,
    });
    this.lastJerkAnswerAt.set(chatId, Date.now());
    this.logger.log(`${this.tag(chatId)}: ответ отправлен`);
  }

  /** Иногда ставит на сообщение реакцию-эмодзи (🤡 или 💩). */
  private maybeReact(ctx: BotContext, s: TrollRuntimeSettings): void {
    if (!s.reactionEnabled) {
      return;
    }

    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    if (chatId === undefined || messageId === undefined) {
      return;
    }

    if (this.withinCooldown(this.lastReactionAt, chatId, s.reactionCooldownSec)) {
      return;
    }
    if (Math.random() >= s.reactionChance) {
      return;
    }

    // Чередуем эмодзи: одну и ту же реакцию дважды подряд не ставим.
    const previous = this.lastReactionEmoji.get(chatId);
    const candidates = REACTION_EMOJIS.filter((candidate) => candidate !== previous);
    const emoji = candidates[Math.floor(Math.random() * candidates.length)];
    void this.setReaction(chatId, messageId, emoji);
  }

  private async setReaction(
    chatId: number,
    messageId: number,
    emoji: ReactionTypeEmoji['emoji']
  ): Promise<void> {
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
      this.lastReactionAt.set(chatId, Date.now());
      this.lastReactionEmoji.set(chatId, emoji as (typeof REACTION_EMOJIS)[number]);
      this.logger.log(`${this.tag(chatId)}: поставил реакцию ${emoji}`);
    } catch (error) {
      // Некоторые чаты ограничивают набор реакций — пробуем вторую.
      const alternative = REACTION_EMOJIS.find((candidate) => candidate !== emoji);
      if (alternative) {
        try {
          await this.bot.api.setMessageReaction(chatId, messageId, [
            { type: 'emoji', emoji: alternative },
          ]);
          this.lastReactionAt.set(chatId, Date.now());
          this.lastReactionEmoji.set(chatId, alternative);
          this.logger.log(`${this.tag(chatId)}: поставил реакцию ${alternative} (первая не прошла)`);
          return;
        } catch {
          // Ниже логируем исходную ошибку.
        }
      }
      // Ничего не вышло — паузу не тратим, попробуем на следующем сообщении.
      this.logger.warn(
        `${this.tag(chatId)}: не удалось поставить реакцию — ${this.describeError(error)}`
      );
    }
  }

  /**
   * /stat — считает потенциальный срок лично для того, кто запросил,
   * по его сообщениям за сутки из истории. Работает только в активном чате.
   */
  private async onStatCommand(ctx: BotContext): Promise<void> {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }
    if (!ctx.from || ctx.from.is_bot) {
      return;
    }

    const s = this.settings.current;
    if (!s.enabled || !s.criminalEnabled) {
      return;
    }

    if (!(await this.isChatActive(chat.id))) {
      return;
    }

    // Запрашивать может только участник этого чата.
    try {
      const member = await ctx.api.getChatMember(chat.id, ctx.from.id);
      if (member.status === 'left' || member.status === 'kicked') {
        await ctx.reply('Ты не участник этого чата');
        return;
      }
    } catch (error) {
      this.logger.warn(
        `${this.tag(chat.id, ctx.from.id)}: /stat — не смог проверить участника: ${this.describeError(error)}`
      );
      await ctx.reply('Не получилось проверить, что ты участник чата');
      return;
    }

    // Кулдаун отдельно на каждого пользователя в чате.
    const statKey = `${chat.id}:${ctx.from.id}`;
    const lastAt = this.lastStatAt.get(statKey);
    if (lastAt !== undefined && Date.now() - lastAt < TROLL_STAT_COOLDOWN_SEC * 1000) {
      await ctx.reply('Статистику можно запрашивать не так часто, подожди немного');
      return;
    }
    this.lastStatAt.set(statKey, Date.now());

    const since = new Date(Date.now() - TROLL_HISTORY_TTL_HOURS * 60 * 60 * 1000);
    // Самые свежие сообщения пользователя за сутки (не самые старые).
    const rows = (
      await this.history.find({
        where: {
          chatId: chat.id,
          role: 'user',
          userId: ctx.from.id,
          createdAt: MoreThanOrEqual(since),
        },
        order: { id: 'DESC' },
        take: TROLL_STAT_MAX_MESSAGES_PER_USER,
      })
    ).reverse();

    if (!rows.length) {
      await ctx.reply('🔒 За 24 часа ты ничего не писал — и сроков нет');
      return;
    }

    this.logger.log(
      `${this.tag(chat.id, ctx.from.id)}: /stat — считаю срок по ${rows.length} сообщ.`
    );
    void this.sendTyping(chat.id);

    const joined = rows.map((row, index) => `${index + 1}) ${row.content}`).join('\n');
    const cleaned = sanitizeTranscript(joined, TROLL_STAT_MAX_CHARS);

    const stat = await this.deepSeek.completeJson<CriminalStat>(
      CRIMINAL_STAT_PROMPT,
      wrapUserContent(cleaned),
      { temperature: 0.6, maxTokens: 1000, label: 'стат' }
    );

    // Модель не ответила (таймаут/лимит) — не врём про «0 лет», а честно признаёмся.
    if (!stat) {
      this.logger.warn(`${this.tag(chat.id, ctx.from.id)}: /stat — пустой ответ модели`);
      await this.safeSendToChat(chat.id, 'чёт я подвис, попробуй ещё раз', ctx.message?.message_id);
      return;
    }

    const articles = Array.isArray(stat?.articles)
      ? stat.articles
          .filter((article) => article && article.code)
          .slice(0, 5)
          .map((article) => ({
            code: sanitizeModelField(article.code, TROLL_MAX_CRIMINAL_TITLE_CHARS),
            title: sanitizeModelField(article.title, TROLL_MAX_CRIMINAL_TITLE_CHARS),
            years: Math.max(0, Math.round(Number(article.years) || 0)),
            reason: sanitizeModelField(article.reason, TROLL_MAX_CRIMINAL_REASON_CHARS),
          }))
          .filter((article) => !!article.code)
      : [];

    // Срок считаем сами — суммой по статьям (а не доверяем числу из модели).
    const totalYears = articles.length
      ? articles.reduce((sum, article) => sum + article.years, 0)
      : Math.max(0, Math.round(Number(stat?.years) || 0));

    const name = this.escapeHtml(ctx.from.first_name || 'друг');
    const lines = [`🔒 ${name}, твой потенциальный срок за 24 часа:`];
    if (totalYears > 0) {
      for (const article of articles) {
        const title = article.title ? ` (${this.escapeHtml(article.title)})` : '';
        const why = article.reason ? `: ${this.escapeHtml(article.reason)}` : '';
        lines.push(`• ${this.escapeHtml(article.code)}${title} — ${article.years} лет${why}`);
      }
      lines.push(`Итого: ${totalYears} лет`);
    } else {
      lines.push('• 0 лет — пока чисто');
    }

    await this.safeSendToChat(chat.id, lines.join('\n'), ctx.message?.message_id);
    this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /stat — отправлено (лет: ${totalYears})`);
  }

  /**
   * /future — предсказание на день. С шансом 1% доброе, иначе злое и обидное.
   * Кэшируется: одно предсказание на пользователя раз в 12 часов.
   */
  private async onFutureCommand(ctx: BotContext): Promise<void> {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }
    if (!ctx.from || ctx.from.is_bot) {
      return;
    }

    const s = this.settings.current;
    if (!s.enabled) {
      return;
    }
    if (!(await this.isChatActive(chat.id))) {
      return;
    }

    // Имя запросившего нужно, чтобы восстановить регистр в предсказании.
    this.trackName(chat.id, ctx.from.id, this.describeUser(ctx.from));

    const since = new Date(Date.now() - TROLL_FUTURE_COOLDOWN_HOURS * 60 * 60 * 1000);
    const cached = await this.predictions.findOne({
      where: { chatId: chat.id, userId: ctx.from.id, createdAt: MoreThanOrEqual(since) },
      order: { id: 'DESC' },
    });

    if (cached) {
      const nextCount = (cached.requests ?? 1) + 1;

      // Первые два запроса — отдаём то же предсказание.
      if (nextCount <= TROLL_FUTURE_ANGRY_AFTER) {
        await this.predictions.update({ id: cached.id }, { requests: nextCount });
        await this.safeSendToChat(
          chat.id,
          this.finalizePrediction(chat.id, cached.text),
          ctx.message?.message_id
        );
        this.logger.log(
          `${this.tag(chat.id, ctx.from.id)}: /future — из кэша (запрос #${nextCount})`
        );
        return;
      }

      // Слишком настырно — меняем предсказание на обидное, кулдаун не сбрасываем.
      this.logger.log(
        `${this.tag(chat.id, ctx.from.id)}: /future — запрос #${nextCount}, гадаю обидное`
      );
      void this.sendTyping(chat.id);

      const technique = this.pickFutureTechnique();
      const avoid = await this.recentPredictions(chat.id, [cached.text]);
      this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /future — приём «${technique}»`);
      const rawAngry = await this.deepSeek.completeText(
        FUTURE_ANGRY_PROMPT,
        this.buildPredictionRequest(ctx.from, avoid, technique),
        { maxTokens: 80, temperature: 1.05, label: 'предсказание-злое' }
      );
      const angry = this.finalizePrediction(chat.id, rawAngry);

      if (!angry) {
        await this.safeSendToChat(
          chat.id,
          this.finalizePrediction(chat.id, cached.text),
          ctx.message?.message_id
        );
        return;
      }

      await this.predictions.update({ id: cached.id }, { text: angry, requests: nextCount });
      await this.safeSendToChat(chat.id, angry, ctx.message?.message_id);
      this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /future — обидное отправлено`);
      return;
    }

    const isGood = Math.random() < TROLL_FUTURE_GOOD_CHANCE;
    this.logger.log(
      `${this.tag(chat.id, ctx.from.id)}: /future — генерирую (${isGood ? 'доброе' : 'плохое'})`
    );
    void this.sendTyping(chat.id);

    const avoid = await this.recentPredictions(chat.id);
    const technique = this.pickFutureTechnique();
    this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /future — приём «${technique}»`);
    const raw = await this.deepSeek.completeText(
      isGood ? FUTURE_GOOD_PROMPT : FUTURE_BAD_PROMPT,
      this.buildPredictionRequest(ctx.from, avoid, technique),
      { maxTokens: 80, temperature: isGood ? 0.9 : 1.05, label: isGood ? 'предсказание-доброе' : 'предсказание' }
    );

    const text = this.finalizePrediction(chat.id, raw);
    if (!text) {
      this.logger.warn(`${this.tag(chat.id)}: /future — пустой ответ модели`);
      return;
    }

    try {
      await this.predictions.insert({
        chatId: chat.id,
        userId: ctx.from.id,
        text,
        requests: 1,
      });
    } catch (error) {
      this.logger.warn(`Предсказания: не удалось сохранить: ${this.describeError(error)}`);
    }

    await this.safeSendToChat(chat.id, text, ctx.message?.message_id);
    this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /future — отправлено`);
  }

  /**
   * Прошлые предсказания чата: передаём их модели в задании, чтобы она не
   * повторяла ни тему, ни приём (промпт статeless и без списка зацикливается).
   */
  private async recentPredictions(chatId: number, extra: string[] = []): Promise<string[]> {
    let stored: string[] = [];
    try {
      const rows = await this.predictions.find({
        where: { chatId },
        order: { id: 'DESC' },
        take: TROLL_FUTURE_AVOID_REPEAT,
      });
      stored = rows.map((row) => row.text);
    } catch (error) {
      this.logger.warn(`Предсказания: не удалось прочитать историю: ${this.describeError(error)}`);
    }

    return [...extra, ...stored]
      .map((text) => sanitizeModelStyled(text ?? '', TROLL_FUTURE_MAX_CHARS))
      .filter((text) => !!text)
      .slice(0, TROLL_FUTURE_AVOID_REPEAT + extra.length);
  }

  /** Случайный приём предсказания: гарантирует разнообразие между запросами. */
  private pickFutureTechnique(): string {
    return TROLL_FUTURE_TECHNIQUES[Math.floor(Math.random() * TROLL_FUTURE_TECHNIQUES.length)];
  }

  /** Задание для /future: кому гадаем, приём и список уже сказанного. */
  private buildPredictionRequest(
    user: User | undefined,
    avoid: string[],
    technique: string
  ): string {
    const lines = [`Кому гадаем: ${this.describeUser(user)}`, `Приём: ${technique}`];
    if (avoid.length) {
      lines.push(`Уже говорил этому чату (не повторяй ни тему, ни приём, ни зачин): ${avoid.join(' | ')}`);
    }
    return wrapUserContent(lines.join('\n'));
  }

  /** /meme — репостит случайный живой мем из канала. Не чаще раза в час. */
  private async onMemeCommand(ctx: BotContext): Promise<void> {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }
    if (!ctx.from || ctx.from.is_bot) {
      return;
    }

    const s = this.settings.current;
    if (!s.enabled) {
      return;
    }
    if (!(await this.isChatActive(chat.id))) {
      return;
    }

    // Кулдаун отдельно на каждого участника чата.
    const memeKey = `${chat.id}:${ctx.from.id}`;
    const lastAt = this.lastMemeAt.get(memeKey);
    if (lastAt !== undefined && Date.now() - lastAt < TROLL_MEME_COOLDOWN_SEC * 1000) {
      const minutesLeft = Math.max(
        1,
        Math.ceil((TROLL_MEME_COOLDOWN_SEC * 1000 - (Date.now() - lastAt)) / 60000)
      );
      this.logger.log(
        `${this.tag(chat.id, ctx.from.id)}: /meme — на кулдауне (${minutesLeft} мин), отказываю`
      );
      await this.denyRudely(ctx, `ты недавно уже просил мем, возвращайся через ${minutesLeft} мин`);
      return;
    }
    this.lastMemeAt.set(memeKey, Date.now());

    const memes = await this.memes.find({
      where: { channelType: 'main' },
      order: { id: 'DESC' },
      take: TROLL_MEME_POOL_SIZE,
    });
    if (!memes.length) {
      this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /meme — мемов в базе нет`);
      await this.denyRudely(ctx, 'в базе нет мемов, прислать нечего');
      return;
    }

    const pool = [...memes];
    for (let attempt = 0; attempt < TROLL_MEME_MAX_ATTEMPTS && pool.length; attempt += 1) {
      const index = Math.floor(Math.random() * pool.length);
      const meme = pool.splice(index, 1)[0];

      try {
        await this.repostMeme(chat.id, meme.channelId, meme.messageId);
        this.logger.log(
          `${this.tag(chat.id)}: /meme — репостнул мем ${meme.messageId} из ${meme.channelId}`
        );
        return;
      } catch (error) {
        const message = this.describeError(error);
        this.logger.warn(`${this.tag(chat.id)}: /meme — мем ${meme.messageId} недоступен: ${message}`);
        // Если мем удалён из канала — чистим запись, чтобы больше не попадался.
        if (/not found|to copy|to forward/i.test(message)) {
          try {
            await this.memes.delete({ id: meme.id });
          } catch (deleteError) {
            this.logger.warn(
              `${this.tag(chat.id)}: /meme — не смог удалить мёртвый мем ${meme.id}: ${this.describeError(
                deleteError
              )}`
            );
          }
        }
      }
    }

    this.logger.warn(`${this.tag(chat.id, ctx.from.id)}: /meme — живых мемов не нашлось`);
    await this.denyRudely(ctx, 'все мемы оказались удалены, пришли новый');
  }

  /**
   * Репостит мем из канала. Сначала пробуем forward (настоящий репост с
   * указанием канала), если канал запрещает пересылку — отправляем копию.
   */
  private async repostMeme(chatId: number, channelId: string, messageId: number): Promise<void> {
    try {
      await this.bot.api.forwardMessage(chatId, Number(channelId), Number(messageId));
    } catch (error) {
      this.logger.warn(
        `${this.tag(chatId)}: /meme — forward не удался (${this.describeError(error)}), пробую копию`
      );
      await this.bot.api.copyMessage(chatId, Number(channelId), Number(messageId));
    }
  }

  /** Обидный отказ с объяснением причины (используется в /meme и /sumarize). */
  private async denyRudely(ctx: BotContext, reason: string): Promise<void> {
    const raw = await this.deepSeek.completeText(
      MEME_DENY_PROMPT,
      wrapUserContent(`причина: ${reason}`),
      { maxTokens: 50, temperature: 1.05, label: 'отказ' }
    );
    const text = toChatStyle(sanitizeModelText(raw ?? '', TROLL_MAX_REPLY_CHARS));
    await this.safeSendToChat(ctx.chat.id, text || 'нет, не сейчас', ctx.message?.message_id);
  }

  /**
   * /sumarize — пересказ переписки с момента прошлого запроса.
   * Кулдаун общий на чат — 1 час. Запросить может любой участник.
   */
  private async onSummaryCommand(ctx: BotContext): Promise<void> {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }
    if (!ctx.from || ctx.from.is_bot) {
      return;
    }

    const s = this.settings.current;
    if (!s.enabled) {
      return;
    }
    if (!(await this.isChatActive(chat.id))) {
      return;
    }

    // Кулдаун общий на весь чат, поэтому храним время последнего запроса в БД.
    const chatRow = await this.chats.findOne({ where: { chatId: chat.id } });
    const lastAt = chatRow?.lastSummaryAt ? new Date(chatRow.lastSummaryAt).getTime() : null;
    if (lastAt !== null && Date.now() - lastAt < TROLL_SUMMARY_COOLDOWN_SEC * 1000) {
      const minutesLeft = Math.max(
        1,
        Math.ceil((TROLL_SUMMARY_COOLDOWN_SEC * 1000 - (Date.now() - lastAt)) / 60000)
      );
      this.logger.log(
        `${this.tag(chat.id, ctx.from.id)}: /sumarize — на кулдауне (${minutesLeft} мин), отказываю`
      );
      await this.denyRudely(ctx, `пересказ просили недавно, возвращайся через ${minutesLeft} мин`);
      return;
    }

    const since = lastAt !== null ? new Date(lastAt) : new Date(Date.now() - TROLL_HISTORY_TTL_HOURS * 60 * 60 * 1000);

    // Берём самые свежие реплики окна: order DESC + take, потом возвращаем хронологию.
    // Только сообщения людей: ответы самого бота в пересказ не идут.
    let rows = await this.history.find({
      where: { chatId: chat.id, role: 'user', createdAt: MoreThanOrEqual(since) },
      order: { id: 'DESC' },
      take: TROLL_SUMMARY_MAX_MESSAGES,
    });

    // Окно пустое (с прошлого пересказа не писали или метки времени разъехались) —
    // не отказываем, а пересказываем последние реплики чата.
    if (!rows.length) {
      this.logger.log(
        `${this.tag(chat.id, ctx.from.id)}: /sumarize — окно пустое, беру последние ${TROLL_SUMMARY_FALLBACK_MESSAGES} сообщ.`
      );
      rows = await this.history.find({
        where: { chatId: chat.id, role: 'user' },
        order: { id: 'DESC' },
        take: TROLL_SUMMARY_FALLBACK_MESSAGES,
      });
    }

    if (!rows.length) {
      this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /sumarize — истории нет вообще`);
      await this.safeSendToChat(
        chat.id,
        'тут вообще ничего не писали, пересказывать нечего',
        ctx.message?.message_id
      );
      return;
    }

    const ordered = [...rows].reverse();

    this.logger.log(
      `${this.tag(chat.id, ctx.from.id)}: /sumarize — пересказываю ${ordered.length} сообщ.`
    );
    void this.sendTyping(chat.id);

    const joined = ordered
      .map((row) => {
        // Имена нужны и для восстановления регистра в ответе: карта чата живёт
        // в памяти и в /sumarize сама не пополняется.
        this.trackName(chat.id, row.userId, row.userName);
        return `${row.userName ?? 'кто-то'}: ${row.content}`;
      })
      .join('\n');
    const cleaned = sanitizeTranscript(joined, TROLL_SUMMARY_MAX_CHARS);

    const raw = await this.deepSeek.completeText(SUMMARY_PROMPT, wrapUserContent(cleaned), {
      temperature: 0.9,
      maxTokens: TROLL_SUMMARY_MAX_TOKENS,
      label: 'саммари',
    });

    const text = this.restoreNames(
      chat.id,
      toChatStyle(sanitizeModelText(raw ?? '', TROLL_SUMMARY_MAX_REPLY_CHARS))
    );
    if (!text) {
      this.logger.warn(`${this.tag(chat.id, ctx.from.id)}: /sumarize — пустой ответ модели`);
      await this.safeSendToChat(chat.id, 'чёт я подвис, попробуй позже', ctx.message?.message_id);
      return;
    }

    // Метку окна двигаем только после того, как пересказ реально ушёл в чат:
    // иначе неудачная отправка или пустой ответ съедали бы все сообщения.
    const sent = await this.safeSendToChat(chat.id, text, ctx.message?.message_id);
    if (!sent) {
      this.logger.warn(
        `${this.tag(chat.id, ctx.from.id)}: /sumarize — отправить не удалось, метку окна не двигаю`
      );
      return;
    }

    await this.chats.update({ chatId: chat.id }, { lastSummaryAt: new Date() });
    await this.remember(chat.id, 'assistant', text, {
      messageId: sent,
      replyToMessageId: ctx.message?.message_id,
    });
    this.logger.log(`${this.tag(chat.id, ctx.from.id)}: /sumarize — отправлено`);
  }

  /**
   * Решает, кривляться ли сейчас, и выбирает слово из сообщения.
   * Возвращает слово для переделки или null.
   */
  private pickMirrorWord(
    chatId: number,
    text: string,
    s: TrollRuntimeSettings
  ): string | null {
    if (this.jerkBatches.has(chatId)) {
      return null;
    }
    if (this.withinCooldown(this.lastMirrorAt, chatId, s.mirrorCooldownSec)) {
      return null;
    }

    const words = (text.match(/[а-яёА-ЯЁ]+/g) ?? []).filter(
      (word) => word.length >= TROLL_MIRROR_MIN_WORD_LEN
    );
    if (!words.length) {
      return null;
    }

    if (Math.random() >= s.mirrorChance) {
      return null;
    }

    this.lastMirrorAt.set(chatId, Date.now());
    return words[Math.floor(Math.random() * words.length)];
  }

  /** Переделывает выбранное слово через LLM и отправляет результат. */
  private async generateMirror(
    ctx: BotContext,
    word: string,
    s: TrollRuntimeSettings
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    const technique =
      TROLL_MIRROR_TECHNIQUES[Math.floor(Math.random() * TROLL_MIRROR_TECHNIQUES.length)];
    const seedList =
      technique.seed === 'prefix'
        ? TROLL_MIRROR_PREFIXES
        : technique.seed === 'infix'
          ? TROLL_MIRROR_INFIXES
          : null;
    const seed = seedList ? seedList[Math.floor(Math.random() * seedList.length)] : '';

    this.logger.log(
      `${this.tag(chatId, ctx.from?.id)}: кривляюсь (приём «${technique.name}»${
        seed ? `, слог «${seed}»` : ''
      }, слово длиной ${word.length})`
    );
    void this.sendTyping(chatId);

    const input = [`слово: ${word}`, `приём: ${technique.name}`, seed ? `матерный слог: ${seed}` : '']
      .filter((line) => !!line)
      .join('\n');
    const cleaned = sanitizeUserInput(input, s.maxInputChars);
    const reply = await this.deepSeek.completeText(MIRROR_PROMPT, wrapUserContent(cleaned), {
      maxTokens: 24,
      temperature: 1.0,
      label: 'кривляние',
    });

    const mirrored = toChatStyle(this.normalizeMirrorWord(reply ?? ''));
    if (!mirrored) {
      this.logger.warn(`${this.tag(chatId)}: кривляние — пустой ответ модели`);
      return;
    }

    const sentId = await this.safeReply(ctx, mirrored);
    await this.remember(chatId, 'assistant', mirrored, {
      messageId: sentId ?? undefined,
      replyToMessageId: ctx.message?.message_id,
    });
    this.logger.log(`${this.tag(chatId)}: кривляние отправлено (длина ${mirrored.length})`);
  }

  /** Приводит ответ модели к одному слову (буквы и дефис). */
  private normalizeMirrorWord(raw: string): string {
    return this.formatter.normalizeMirrorWord(raw);
  }

  private async replyWithSarcasm(ctx: BotContext, s: TrollRuntimeSettings): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    // Случайная реакция — не чаще заданного кулдауна на чат.
    if (this.withinCooldown(this.lastSarcasmAt, chatId, s.sarcasmCooldownSec)) {
      this.logger.debug(`${this.tag(chatId)}: сарказм на паузе — пропуск`);
      return;
    }
    if (Math.random() >= s.sarcasmChance) {
      this.logger.debug(`${this.tag(chatId)}: бросок сарказма (шанс ${this.pct(s.sarcasmChance)}) — не сработал`);
      return;
    }
    this.lastSarcasmAt.set(chatId, Date.now());
    this.logger.log(`${this.tag(chatId)}: сарказм сработал — генерирую подкол`);

    const reply = await this.generateCheckedReply(
      SARCASM_PROMPT,
      chatId,
      { maxTokens: 160, temperature: 1.05, label: 'подкол' },
      { userId: ctx.from?.id, userName: this.describeUser(ctx.from) },
      (raw) =>
        this.restoreNames(chatId, toChatStyle(sanitizeModelText(raw, TROLL_MAX_REPLY_CHARS)))
    );

    const safe = reply ?? '';
    if (safe) {
      const sentId = await this.safeReply(ctx, safe);
      await this.remember(chatId, 'assistant', safe, {
        messageId: sentId ?? undefined,
        replyToMessageId: ctx.message?.message_id,
      });
      this.logger.log(`${this.tag(chatId)}: сарказм отправлен`);
    } else {
      this.logger.warn(`${this.tag(chatId)}: пустой ответ модели (сарказм) — не отправляю`);
    }
  }

  /** Немедленный «мудак»-ответ (используется при выключенном окне накопления). */
  private async replyAsJerk(ctx: BotContext): Promise<void> {
    const chatId = ctx.chat.id;
    this.logger.log(`${this.tag(chatId, ctx.from?.id)}: отвечаю сразу (режим «мудак») — генерирую`);
    void this.sendTyping(chatId);

    const reply = await this.generateCheckedReply(
      JERK_PROMPT,
      chatId,
      { maxTokens: TROLL_JERK_MAX_TOKENS, temperature: 1.05, label: 'ответ на обращение' },
      { userId: ctx.from?.id, userName: this.describeUser(ctx.from) },
      (raw) =>
        this.restoreNames(chatId, toChatStyle(sanitizeModelText(raw, TROLL_MAX_REPLY_CHARS)))
    );

    const safe = reply ?? '';
    if (safe) {
      const sentId = await this.safeReply(ctx, safe);
      await this.remember(chatId, 'assistant', safe, {
        messageId: sentId ?? undefined,
        replyToMessageId: ctx.message?.message_id,
      });
      this.logger.log(`${this.tag(chatId)}: ответ отправлен`);
    } else {
      this.logger.warn(`${this.tag(chatId)}: пустой ответ модели (мудак) — не отправляю`);
    }
  }

  private buildCriminalReply(
    assessment: CriminalAssessment,
    probability: number,
    s: TrollRuntimeSettings
  ): string {
    return this.formatter.buildCriminalReply(assessment, probability, s);
  }

  private async onMyChatMember(ctx: BotContext): Promise<void> {
    const update = ctx.myChatMember;
    if (!update) {
      return;
    }

    const chat = update.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return;
    }

    const newStatus = update.new_chat_member.status;
    const oldStatus = update.old_chat_member.status;

    const wasOut = oldStatus === 'left' || oldStatus === 'kicked';
    const isIn = newStatus === 'member' || newStatus === 'administrator';
    const isOutNow = newStatus === 'left' || newStatus === 'kicked';

    this.logger.log(
      `my_chat_member: чат=${chat.id} «${chat.title ?? ''}» ${oldStatus} → ${newStatus}`
    );

    if (isOutNow) {
      await this.chats.update({ chatId: chat.id }, { isActive: false });
      this.logger.log(`Чат ${chat.id}: бот удалён — деактивирован`);
      return;
    }

    if (!isIn || !wasOut) {
      return;
    }

    await this.chats.upsert(
      {
        chatId: chat.id,
        title: chat.title ?? null,
        addedByUserId: update.from.id,
        isActive: false,
      },
      ['chatId']
    );
    this.logger.log(`Чат ${chat.id}: бот добавлен — жду подтверждения владельца`);

    await this.notifyOwnerAboutNewChat(chat.id, chat.title, update.from);
  }

  private async notifyOwnerAboutNewChat(
    chatId: number,
    title: string | undefined,
    from: User
  ): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('✅ Подтвердить', `${TrollCallbackEnum.APPROVE_PREFIX}${chatId}`)
      .text('❌ Отклонить', `${TrollCallbackEnum.REJECT_PREFIX}${chatId}`);

    const who = [from.first_name, from.username ? `@${from.username}` : null]
      .filter((value) => !!value)
      .join(' ');

    const text =
      '🤖 <b>Бота добавили в чат</b>\n\n' +
      `Чат: <b>${this.escapeHtml(title || String(chatId))}</b>\n` +
      `ID: <code>${chatId}</code>\n` +
      `Кто добавил: ${this.escapeHtml(who || String(from.id))}\n\n` +
      'Бот начнёт работать в чате только после подтверждения.';

    try {
      await this.bot.api.sendMessage(this.config.ownerId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      this.logger.log(`Чат ${chatId}: уведомление владельцу отправлено`);
    } catch (error) {
      this.logger.error(`Failed to notify owner about chat ${chatId}`, error);
    }
  }

  private async onOwnerDecision(ctx: BotContext): Promise<void> {
    if (!ctx.from || ctx.from.id !== this.config.ownerId) {
      this.logger.warn(`Подтверждение тролля: попытка не от владельца (user=${ctx.from?.id ?? '?'})`);
      await ctx.answerCallbackQuery('Эта кнопка не для тебя');
      return;
    }

    const match = ctx.match as RegExpMatchArray | undefined;
    if (!match) {
      return;
    }

    const action = match[1];
    const chatId = Number(match[2]);

    if (action === 'approve') {
      await this.chats.update({ chatId }, { isActive: true });
      this.logger.log(`Чат ${chatId}: владелец подтвердил — тролль активирован`);
      await ctx.answerCallbackQuery('Подтверждено');
      await this.safeEditMessage(ctx, '✅ Бот активирован, теперь он работает в чате.');

      await this.safeSendToChat(
        chatId,
        'Всем привет, теперь я тут работаю — постарайтесь не сморозить уголовщину 🤡'
      );
      return;
    }

    await this.chats.update({ chatId }, { isActive: false });
    this.logger.log(`Чат ${chatId}: владелец отклонил — бот выходит`);
    await ctx.answerCallbackQuery('Отклонено');
    await this.safeEditMessage(ctx, '❌ Бот не будет работать в этом чате.');

    try {
      await this.bot.api.leaveChat(chatId);
    } catch (error) {
      this.logger.warn(`Failed to leave chat ${chatId}: ${this.describeError(error)}`);
    }
  }

  /**
   * Личные сообщения боту. Для тролля здесь один сценарий: владелец
   * форвардит (или присылает текстом) ответ бота, который считает дефектом.
   * Бот находит этот ответ в истории, записывает дефект в БД и отвечает
   * расширенной диагностикой от старшей модели.
   *
   * Работает только для владельца и только для ответов из чатов, где тролль включён.
   */
  private async onPrivateMessage(ctx: BotContext): Promise<void> {
    if (!ctx.from || !ctx.message || ctx.from.id !== this.config.ownerId) {
      return;
    }

    const text = this.messageText(ctx);
    if (!text) {
      return;
    }

    const forwarded = ctx.message.forward_origin;
    const match = await this.findReportedAnswer(text, forwarded?.date);

    if (!match) {
      // На форвард честно отвечаем, на обычный текст в личке молчим.
      if (forwarded) {
        this.logger.log(`${this.tag(ctx.chat.id, ctx.from.id)}: ответ на разбор не найден`);
        await this.safeSendToChat(
          ctx.chat.id,
          'не нашёл этот ответ в истории: помню последние 24 часа и только чаты, где тролль включён',
          ctx.message.message_id
        );
      }
      return;
    }

    const sourceChat = await this.chats.findOne({ where: { chatId: match.candidate.chatId } });
    if (!sourceChat?.isActive) {
      this.logger.log(
        `${this.tag(ctx.chat.id, ctx.from.id)}: чат ${match.candidate.chatId} не в тролль-режиме, разбор отклонён`
      );
      await this.safeSendToChat(
        ctx.chat.id,
        `ответ из чата «${sourceChat?.title ?? match.candidate.chatId}», но тролль там выключен: разбирать нечего`,
        ctx.message.message_id
      );
      return;
    }

    this.logger.log(
      `${this.tag(ctx.chat.id, ctx.from.id)}: разбираю дефект (чат ${match.candidate.chatId}, совпадение ${match.exact ? 'точное' : 'по нормализации'})`
    );

    const replyTo = await this.findDefectReplyTo(match.candidate);
    const context = await this.buildDefectContext(match.candidate);
    const diagnosis = await this.diagnoseDefect({
      answer: match.candidate.content,
      replyTo,
      context,
      sourceChatTitle: sourceChat.title ?? null,
    });

    const defect = await this.defects.save(
      this.defects.create({
        sourceChatId: match.candidate.chatId,
        sourceChatTitle: sourceChat.title ?? null,
        botMessageId: match.candidate.messageId ?? null,
        botAnswer: match.candidate.content,
        replyToMessageId: replyTo?.messageId ?? null,
        replyToUserId: replyTo?.userId ?? null,
        replyToUserName: replyTo?.userName ?? null,
        replyToText: replyTo?.content ?? null,
        context: context || null,
        matchKind: match.exact ? 'exact' : 'normalized',
        reportedBy: ctx.from.id,
        reportedInChatId: ctx.chat.id,
        severity: diagnosis.severity,
        diagnosis: diagnosis.text,
      })
    );

    this.logger.log(
      `${this.tag(ctx.chat.id, ctx.from.id)}: дефект #${defect.id} записан (серьёзность ${diagnosis.severity})`
    );

    await this.safeSendToChat(
      ctx.chat.id,
      this.formatDefectReport(defect, match.candidate, replyTo, diagnosis),
      ctx.message.message_id
    );
  }

  /** Текст сообщения или подписи к нему. */
  private messageText(ctx: BotContext): string {
    return this.formatter.messageText(ctx);
  }

  /**
   * Ищет в истории ответ бота, который прислал владелец.
   * Форвард из группы не несёт id исходного сообщения, поэтому опираемся
   * на текст и — если Telegram отдал дату — на время отправки.
   */
  private async findReportedAnswer(
    text: string,
    sentAtSeconds?: number
  ): Promise<{ candidate: TrollMessageEntity; exact: boolean } | null> {
    const activeChats = await this.chats.find({ where: { isActive: true } });
    const chatIds = activeChats.map((chat) => Number(chat.chatId));
    if (!chatIds.length) {
      return null;
    }

    // Когда известна дата отправки, окно поиска узкое — берём все ответы из него.
    const sentAt = sentAtSeconds ? new Date(sentAtSeconds * 1000) : undefined;
    const since = new Date(Date.now() - TROLL_HISTORY_TTL_HOURS * 60 * 60 * 1000);
    const rows = await this.history.find({
      where: sentAt
        ? {
            role: 'assistant',
            chatId: In(chatIds),
            createdAt: Between(
              new Date(sentAt.getTime() - TROLL_DEFECT_TIME_WINDOW_MS),
              new Date(sentAt.getTime() + TROLL_DEFECT_TIME_WINDOW_MS)
            ),
          }
        : { role: 'assistant', chatId: In(chatIds), createdAt: MoreThanOrEqual(since) },
      order: { id: 'DESC' },
      take: TROLL_DEFECT_SEARCH_LIMIT,
    });

    const candidates: DefectCandidate[] = rows.map((row) => ({
      id: row.id,
      chatId: Number(row.chatId),
      content: row.content,
      createdAt: row.createdAt,
    }));

    const found = pickDefectAnswer(candidates, {
      text,
      sentAt,
      windowMs: sentAt ? TROLL_DEFECT_TIME_WINDOW_MS : 0,
    });
    if (!found) {
      this.logger.log(
        `Разбор дефекта: совпадений нет (кандидатов ${candidates.length}, нормализованный текст ${normalizeMatchText(text).length} символов)`
      );
      return null;
    }

    const row = rows.find((item) => item.id === found.candidate.id) ?? null;
    return row ? { candidate: row, exact: found.exact } : null;
  }

  /** Реплика, на которую бот отвечал (по номеру replyTo). */
  private async findDefectReplyTo(
    answer: TrollMessageEntity
  ): Promise<TrollMessageEntity | null> {
    if (answer.replyToMessageId === null || answer.replyToMessageId === undefined) {
      return null;
    }
    return this.history.findOne({
      where: { chatId: answer.chatId, messageId: answer.replyToMessageId },
    });
  }

  /** Контекст беседы на момент ответа — в том виде, в каком его видела модель. */
  private async buildDefectContext(answer: TrollMessageEntity): Promise<string> {
    const s = this.settings.current;
    const rows = await this.history.find({
      where: { chatId: answer.chatId, id: LessThanOrEqual(answer.id) },
      order: { id: 'DESC' },
      take: TROLL_DEFECT_CONTEXT_TURNS,
    });

    const context = buildConversationContext(rows, {
      gapMs: Math.max(1, s.dialogPauseMin) * 60 * 1000,
      maxTurns: TROLL_DEFECT_CONTEXT_TURNS,
      maxChars: TROLL_DEFECT_CONTEXT_CHARS,
    });

    return this.formatTranscript(Number(answer.chatId), context);
  }

  /** Разбор дефекта старшей моделью: серьёзность, проблемы и варианты ответа. */
  private async diagnoseDefect(input: {
    answer: string;
    replyTo: TrollMessageEntity | null;
    context: string;
    sourceChatTitle: string | null;
  }): Promise<{
    severity: string;
    summary: string;
    problems: string[];
    fixes: string[];
    /** Тот же разбор одной строкой — так он хранится в таблице дефектов. */
    text: string;
  }> {
    const replyToLine = input.replyTo
      ? `Отвечал на реплику ${this.cleanName(input.replyTo.userName) ?? 'участника'} (id ${
          input.replyTo.userId ?? 'неизвестен'
        }): ${input.replyTo.content}`
      : 'Отвечал не реплаем: конкретной реплики нет';

    const request = wrapUserContent(
      [
        `Чат: ${input.sourceChatTitle ?? 'без названия'}`,
        `Ответ бота: ${input.answer}`,
        replyToLine,
        `Контекст беседы на тот момент (от старого к новому):\n${input.context}`,
      ].join('\n\n')
    );

    const verdict = await this.deepSeek.completeJson<{
      severity?: unknown;
      summary?: unknown;
      problems?: unknown;
      fixSuggestions?: unknown;
    }>(DEFECT_DIAGNOSTIC_PROMPT, request, {
      model: TROLL_DIAGNOSTIC_MODEL,
      temperature: 0.3,
      maxTokens: TROLL_DIAGNOSTIC_MAX_TOKENS,
      label: 'диагностика',
    });

    if (!verdict) {
      this.logger.warn('Разбор дефекта: модель не ответила');
      return {
        severity: 'unknown',
        summary: 'диагностика не удалась: модель не ответила',
        problems: [],
        fixes: [],
        text: 'диагностика не удалась: модель не ответила',
      };
    }

    const severity = TROLL_DEFECT_SEVERITIES.includes(String(verdict.severity))
      ? String(verdict.severity)
      : 'unknown';
    const list = (value: unknown, limit: number): string[] =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => sanitizeModelField(item, limit))
            .filter((item) => !!item)
            .slice(0, 4)
        : [];

    const summary = sanitizeModelField(String(verdict.summary ?? ''), 300);
    const problems = list(verdict.problems, 220);
    const fixes = list(verdict.fixSuggestions, 220);
    const text = [
      summary,
      ...problems.map((problem) => `• ${problem}`),
      ...fixes.map((fix) => `→ ${fix}`),
    ]
      .filter((line) => !!line)
      .join('\n');

    return { severity, summary, problems, fixes, text };
  }

  /** Ответ владельцу: что ответил бот, кому и что говорит диагностика. */
  private formatDefectReport(
    defect: TrollDefectEntity,
    answer: TrollMessageEntity,
    replyTo: TrollMessageEntity | null,
    diagnosis: { severity: string; summary: string; problems: string[]; fixes: string[] }
  ): string {
    return this.formatter.formatDefectReport(defect, answer, replyTo, diagnosis);
  }

  /** Обрезка длинного текста для сообщения в чат. */
  private cut(text: string, limit: number): string {
    return this.formatter.cut(text, limit);
  }

  private async isChatActive(chatId: number): Promise<boolean> {
    const chat = await this.chats.findOne({ where: { chatId } });
    return !!chat?.isActive;
  }

  private isBotMentioned(ctx: BotContext, content: string | null): boolean {
    const username = ctx.me.username;

    if (content && username && content.includes(`@${username}`)) {
      return true;
    }

    const message = ctx.message;
    const entities = message?.entities ?? message?.caption_entities ?? [];
    return entities.some(
      (entity) => entity.type === 'text_mention' && entity.user?.id === ctx.me.id
    );
  }

  /** Пометка типа нетекстового сообщения (сам контент не храним). */
  private describeMediaKind(message: NonNullable<BotContext['message']>): string | null {
    return this.formatter.describeMediaKind(message);
  }

  /** true, если в сообщении есть ссылка (по сущностям url/text_link). */
  private messageHasLink(message: NonNullable<BotContext['message']>): boolean {
    return this.formatter.messageHasLink(message);
  }

  /**
   * Собирает запись для истории диалога. Текст храним как текст, нетекстовый
   * контент — только пометкой типа, ссылки — без URL. Сам контент не сохраняем.
   */
  private buildHistoryEntry(
    text: string,
    mediaKind: string | null,
    hasLink: boolean,
    maxInputChars: number
  ): string | null {
    return this.formatter.buildHistoryEntry(text, mediaKind, hasLink, maxInputChars);
  }

  /**
   * Системный промпт + история чата с авторами.
   *
   * Контекст — вся история чата, ограниченная бюджетом реплик и символов.
   * Длинные паузы не вырезаются, а помечаются строками
   * «— пауза 2 ч —»: после такой отметки начинается другая беседа, и бот
   * обязан отвечать на то, что пишут сейчас, а не тянуть старую нить.
   *
   * История передаётся одним пользовательским сообщением как расшифровка
   * «Имя: реплика» / «бот: реплика», чтобы модель видела автора каждой реплики
   * и не смешивала собеседников. Если задан focus — это тот, кому адресован
   * ответ: модель обязана ответить именно ему и не приписывать ему чужие слова.
   */
  private async buildConversationMessages(
    system: string,
    chatId: number,
    focus?: TrollFocus
  ): Promise<DeepSeekMessage[]> {
    const parts = await this.buildConversationParts(chatId, focus);
    return [
      { role: 'system', content: system },
      { role: 'user', content: `${wrapUserContent(parts.transcript)}\n\n${parts.directive}` },
    ];
  }

  /**
   * Расшифровка окна беседы в том виде, в каком её видит модель:
   * «Имя (id) [msg N, replyTo M]: текст», строки «бот», метки пауз.
   */
  private formatTranscript(
    chatId: number,
    context: ConversationItem<TrollMessageEntity>[]
  ): string {
    return context
      .map((item) => {
        if (item.kind === 'pause') {
          return `—— разрыв беседы, пауза ${formatConversationPause(item.gapMs)} ——`;
        }

        const row = item.row;
        const ids = this.describeMessageRefs(row.messageId, row.replyToMessageId);
        if (row.role === 'assistant') {
          return `бот${ids}: ${row.content}`;
        }
        // Запоминаем имена из истории — чтобы вернуть регистр в ответе.
        this.trackName(chatId, row.userId, row.userName);
        const name = this.cleanName(row.userName) ?? 'участник';
        const label =
          row.userId !== null && row.userId !== undefined ? `${name} (${row.userId})` : name;
        return `${label}${ids}: ${row.content}`;
      })
      .join('\n');
  }

  /**
   * Собирает расшифровку и задание — один раз на ответ, чтобы при
   * самопроверке и переписываниях не собирать контекст заново.
   */
  private async buildConversationParts(
    chatId: number,
    focus?: TrollFocus
  ): Promise<{ transcript: string; directive: string }> {
    const s = this.settings.current;
    // Рабочий ограничитель объёма — только TTL: в модель уходит вся беседа за сутки.
    const since = new Date(Date.now() - TROLL_HISTORY_TTL_HOURS * 60 * 60 * 1000);
    const rows = await this.history.find({
      where: { chatId, createdAt: MoreThanOrEqual(since) },
      order: { id: 'DESC' },
      take: TROLL_CONTEXT_MAX_TURNS,
    });

    const context = buildConversationContext(rows, {
      // Ноль или мусор в настройке не должен превращать в «паузу» каждый промежуток.
      gapMs: Math.max(1, s.dialogPauseMin) * 60 * 1000,
      maxTurns: TROLL_CONTEXT_MAX_TURNS,
      maxChars: TROLL_CONTEXT_MAX_CHARS,
    });

    const transcript = this.formatTranscript(chatId, context);

    const focusName = this.cleanName(focus?.userName);
    const focusLabel =
      focusName && focus?.userId !== undefined && focus?.userId !== null
        ? `${focusName} (${focus.userId})`
        : focusName;
    const directive = focusLabel
      ? `Отвечай участнику «${focusLabel}» — он к тебе обратился, id в ответ не пиши. По имени обращайся НЕ всегда: обычно просто отвечай по сути, а имя используй изредка (и тогда с большой буквы). В истории у каждого автора в скобках указан его id: если имена совпадают, различай собеседников по id и не приписывай одному чужие реплики. ${MESSAGE_REFS_RULE} ${CONVERSATION_PAUSE_RULE}`
      : `В истории у каждого автора в скобках указан его id — не путай собеседников и не приписывай одному участнику слова другого. ${MESSAGE_REFS_RULE} ${CONVERSATION_PAUSE_RULE}`;

    return { transcript, directive };
  }

  /**
   * Самопроверка ответа и до TROLL_SELF_CHECK_MAX_ATTEMPTS попыток.
   * Готовый ответ оценивает ревизор (SELF_CHECK_PROMPT); если оценка ниже
   * порога из настроек, модель переписывает ответ с учётом замечаний.
   * Возвращает вариант с наибольшей оценкой (или последний, если оценки нет).
   */
  private async generateCheckedReply(
    system: string,
    chatId: number,
    options: { maxTokens?: number; temperature?: number; label: string },
    focus: TrollFocus | undefined,
    sanitize: (raw: string) => string
  ): Promise<string | null> {
    const s = this.settings.current;
    const { label, ...llmOptions } = options;
    const parts = await this.buildConversationParts(chatId, focus);

    const maxAttempts = s.selfCheckEnabled ? TROLL_SELF_CHECK_MAX_ATTEMPTS : 1;
    let best: { text: string; score: number } | null = null;
    let previous = '';
    let issues: string[] = [];

    if (s.selfCheckEnabled) {
      this.logger.log(
        `${this.tag(chatId)}: ${label} — генерирую с самопроверкой (порог ${s.selfCheckThreshold}, до ${maxAttempts} попыток, контекст ${parts.transcript.length} символов)`
      );
    } else {
      this.logger.log(`${this.tag(chatId)}: ${label} — самопроверка выключена, одна попытка`);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const retryNote = attempt > 1 ? buildRetryNote(previous, issues, attempt) : '';
      if (attempt > 1) {
        this.logger.log(
          `${this.tag(chatId)}: ${label} — попытка ${attempt}/${maxAttempts}, переписываю. Замечания ревизора: ${this.logText(
            issues.join('; ') || 'без пояснений',
            500
          )}`
        );
      }

      const raw = await this.deepSeek.complete(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `${wrapUserContent(parts.transcript)}\n\n${parts.directive}${retryNote}`,
          },
        ],
        { ...llmOptions, label: `${label} · генерация ${attempt}/${maxAttempts}` }
      );

      const text = sanitize(raw ?? '');
      if (!text) {
        this.logger.warn(`${this.tag(chatId)}: ${label} — попытка ${attempt}: модель вернула пусто`);
        continue;
      }

      this.logger.log(
        `${this.tag(chatId)}: ${label} — попытка ${attempt}: вариант ${this.logText(text)}`
      );

      if (!s.selfCheckEnabled) {
        return text;
      }

      const verdict = await this.reviewReply(chatId, parts.transcript, text, label);
      if (!best || verdict.score > best.score) {
        best = { text, score: verdict.score };
      }

      if (verdict.score >= s.selfCheckThreshold) {
        this.logger.log(
          `${this.tag(chatId)}: ${label} — попытка ${attempt} принята (оценка ${verdict.score} ≥ ${s.selfCheckThreshold})`
        );
        return text;
      }

      this.logger.log(
        `${this.tag(chatId)}: ${label} — попытка ${attempt} забракована (оценка ${verdict.score} < ${s.selfCheckThreshold}): ${this.logText(
          verdict.issues.join('; ') || 'ревизор не объяснил',
          500
        )}`
      );
      previous = text;
      issues = verdict.issues;
    }

    if (best) {
      this.logger.log(
        `${this.tag(chatId)}: ${label} — попытки исчерпаны, отправляю лучший вариант (оценка ${best.score}): ${this.logText(
          best.text
        )}`
      );
      return best.text;
    }

    this.logger.warn(`${this.tag(chatId)}: ${label} — за ${maxAttempts} попыток не получил ни одного варианта`);
    return null;
  }

  /** Оценка готового ответа ревизором: строгий JSON со score и списком замечаний. */
  private async reviewReply(
    chatId: number,
    transcript: string,
    reply: string,
    label = 'диалог'
  ): Promise<{ score: number; issues: string[] }> {
    // Ревизору хватает хвоста переписки — это экономит токены.
    const tail =
      transcript.length > TROLL_SELF_CHECK_CONTEXT_CHARS
        ? `…\n${transcript.slice(-TROLL_SELF_CHECK_CONTEXT_CHARS)}`
        : transcript;

    const verdict = await this.deepSeek.completeJson<{ score?: number; issues?: unknown }>(
      SELF_CHECK_PROMPT,
      wrapUserContent(`Переписка (последние реплики):\n${tail}\n\nОтвет бота:\n${reply}`),
      { temperature: 0, maxTokens: TROLL_SELF_CHECK_MAX_TOKENS, label: `ревизия · ${label}` }
    );

    if (!verdict) {
      // Ревизор не ответил — не переписываем зря, считаем ответ приемлемым.
      this.logger.warn(
        `${this.tag(chatId)}: ${label} — ревизор не ответил, беру вариант как есть`
      );
      return { score: 1, issues: [] };
    }

    const score = Number(verdict.score);
    const issues = Array.isArray(verdict.issues)
      ? verdict.issues.filter((item): item is string => typeof item === 'string')
      : [];

    return { score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0, issues };
  }

  /**
   * Текст для лога: одним рядом без переносов (чтобы запись не разваливалась)
   * и с ограничением длины.
   */
  private logText(text: string, limit = 1500): string {
    return this.formatter.logText(text, limit);
  }

  /**
   * Метка связей сообщения: « [msg 17, replyTo 15]».
   * msg — номер самого сообщения, replyTo — на чей номер отвечают.
   * Если номеров нет (старые записи), метка пустая.
   */
  private describeMessageRefs(messageId?: number | null, replyToMessageId?: number | null): string {
    return this.formatter.describeMessageRefs(messageId, replyToMessageId);
  }

  /**
   * Возвращает исходный регистр имён участников: toChatStyle() опускает всё
   * в нижний регистр, поэтому имена восстанавливаем по карте имён чата.
   */
  private restoreNames(chatId: number, text: string): string {
    return this.names.restoreNames(chatId, text);
  }

  /** Запоминает отображаемое имя участника для возврата регистра в ответах. */
  private trackName(chatId: number, userId?: number | null, userName?: string | null): void {
    this.names.trackName(chatId, userId, userName);
  }

  /** Имя автора для контекста: одна строка, без делимитеров. */
  private cleanName(name?: string | null): string | null {
    return this.names.cleanName(name);
  }

  /** Сохраняет реплику в историю переписки (с ограничением длины). */
  private async remember(
    chatId: number,
    role: 'user' | 'assistant',
    content: string,
    meta?: {
      userId?: number;
      userName?: string;
      messageId?: number;
      replyToMessageId?: number;
    }
  ): Promise<void> {
    const cleaned = content.trim().slice(0, TROLL_HISTORY_MAX_CHARS);
    if (!cleaned) {
      return;
    }
    if (role === 'user') {
      this.trackName(chatId, meta?.userId, meta?.userName);
    }
    try {
      await this.history.insert({
        chatId,
        role,
        content: cleaned,
        userId: meta?.userId ?? null,
        userName: meta?.userName ?? null,
        messageId: meta?.messageId ?? null,
        replyToMessageId: meta?.replyToMessageId ?? null,
      });
    } catch (error) {
      this.logger.warn(`История: не удалось сохранить реплику: ${this.describeError(error)}`);
    }
  }

  /**
   * Часовая чистка истории по крону (расписание, а не setInterval).
   * Рабочий ограничитель объёма — только TTL: беседу помним сутки целиком.
   */
  @Cron(CronExpression.EVERY_HOUR)
  public async cleanupHistoryJob(): Promise<void> {
    await this.cleanupHistory();
  }

  /**
   * Удаляет историю переписки старше TTL (24 часа). Беседу помним целые сутки,
   * но старое не копим: иначе контекст утонет и подорожает каждый запрос.
   */
  private async cleanupHistory(): Promise<void> {
    const cutoff = new Date(Date.now() - TROLL_HISTORY_TTL_HOURS * 60 * 60 * 1000);
    try {
      const result = await this.history.delete({ createdAt: LessThan(cutoff) });
      if (result.affected) {
        this.logger.log(
          `История переписки: удалено записей старше ${TROLL_HISTORY_TTL_HOURS}ч — ${result.affected}`
        );
      }
    } catch (error) {
      this.logger.warn(`История: не удалось очистить старые записи: ${this.describeError(error)}`);
    }
  }

  /** true, если с момента последнего события прошло меньше кулдауна. */
  private withinCooldown(
    store: Map<number, number>,
    chatId: number,
    cooldownSec: number
  ): boolean {
    return this.cooldowns.withinCooldown(store, chatId, cooldownSec);
  }

  /** Короткий префикс для логов: chat=... user=... (без текста сообщений). */
  private tag(chatId: number | undefined, userId?: number): string {
    return this.formatter.tag(chatId, userId);
  }

  /** Вероятность в процентах для логов. */
  private pct(value: number): string {
    return this.formatter.pct(value);
  }

  /** Приводит текст к одной строке в чатовом стиле (для предсказаний). */
  private finalizePrediction(chatId: number, raw: string | null): string {
    const styled = sanitizeModelStyled(raw ?? '', TROLL_FUTURE_MAX_CHARS);
    return this.restoreNames(chatId, styled.replace(/\s*\n+\s*/g, ' ').trim());
  }

  /** Отвечает на сообщение; возвращает id отправленного сообщения (null — не ушло). */
  private async safeReply(
    ctx: BotContext,
    text: string,
    html = false
  ): Promise<number | null> {
    try {
      const message = await ctx.reply(text, {
        ...(html ? { parse_mode: 'HTML' as const } : {}),
        reply_to_message_id: ctx.message?.message_id,
      });
      this.logger.log(
        `${this.tag(ctx.chat?.id, ctx.from?.id)}: отправлено${this.describeMessageRefs(
          message.message_id,
          ctx.message?.message_id
        )} ${this.logText(text)}`
      );
      return message.message_id;
    } catch (error) {
      this.logger.warn(`Failed to send troll reply: ${this.describeError(error)}`);
      return null;
    }
  }

  /** Отправляет сообщение в чат; возвращает id отправленного сообщения (null — не ушло). */
  private async safeSendToChat(
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): Promise<number | null> {
    try {
      const message = await this.bot.api.sendMessage(chatId, text, {
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });
      this.logger.log(
        `${this.tag(chatId)}: отправлено${this.describeMessageRefs(
          message.message_id,
          replyToMessageId
        )} ${this.logText(text)}`
      );
      return message.message_id;
    } catch (error) {
      // Целевое сообщение могло исчезнуть — пробуем отправить без ответа.
      if (replyToMessageId) {
        try {
          const message = await this.bot.api.sendMessage(chatId, text);
          this.logger.log(
            `${this.tag(chatId)}: отправлено (без ответа)${this.describeMessageRefs(
              message.message_id
            )} ${this.logText(text)}`
          );
          return message.message_id;
        } catch (retryError) {
          this.logger.warn(`Failed to send troll message to ${chatId}: ${this.describeError(retryError)}`);
          return null;
        }
      }
      this.logger.warn(`Failed to send troll message to ${chatId}: ${this.describeError(error)}`);
      return null;
    }
  }

  private async safeEditMessage(ctx: BotContext, text: string): Promise<void> {
    try {
      await ctx.editMessageText(text);
    } catch (error) {
      this.logger.warn(`Failed to edit owner message: ${this.describeError(error)}`);
    }
  }

  private describeUser(from: User | undefined): string {
    return this.formatter.describeUser(from);
  }

  private escapeHtml(value: string): string {
    return this.formatter.escapeHtml(value);
  }

  private describeError(error: unknown): string {
    return this.formatter.describeError(error);
  }
}
