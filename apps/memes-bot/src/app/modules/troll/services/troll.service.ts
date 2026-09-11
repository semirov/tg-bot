import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Bot, InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { Repository } from 'typeorm';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BOT } from '../../bot/providers/bot.provider';
import { BaseConfigService } from '../../config/base-config.service';
import { TROLL_CALLBACK_REGEXP, TrollCallbackEnum } from '../constants/troll-callback.enum';
import {
  CRIMINAL_ASSESSMENT_PROMPT,
  JERK_PROMPT,
  MEME_ANNOUNCE_PROMPT,
  SARCASM_PROMPT,
} from '../constants/troll-prompts';
import { TrollChatEntity } from '../entities/troll-chat.entity';
import { CriminalAssessment } from '../interfaces/troll.interface';
import { DeepSeekService } from './deepseek.service';

/** Сообщения короче этого не анализируем (мусор, «+», «ок» и т.п.). */
const MIN_TEXT_LENGTH = 3;

@Injectable()
export class TrollService implements OnModuleInit {
  private readonly logger = new Logger(TrollService.name);

  /** Чаты, по которым уже идёт анализ — чтобы не плодить запросы к DeepSeek. */
  private readonly analyzingChats = new Set<number>();

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
    private readonly deepSeek: DeepSeekService,
    @InjectRepository(TrollChatEntity)
    private readonly chats: Repository<TrollChatEntity>
  ) {}

  public onModuleInit(): void {
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
  }

  /**
   * Вызывается после публикации мема в основной канал.
   * В дневное время с низкой вероятностью бот может написать в активные чаты.
   */
  public async maybeAnnounceMeme(caption?: string): Promise<void> {
    try {
      if (!this.isDaytime()) {
        return;
      }

      if (Math.random() >= this.config.trollMemeAnnounceChance) {
        return;
      }

      const chats = await this.chats.find({ where: { isActive: true } });
      if (!chats.length) {
        return;
      }

      const text = await this.deepSeek.completeText(
        MEME_ANNOUNCE_PROMPT,
        caption?.trim() ? `Подпись к мему: ${caption.trim()}` : 'В канале только что вышел новый мем.',
        { maxTokens: 120, temperature: 1.0 }
      );

      if (!text) {
        return;
      }

      for (const chat of chats) {
        try {
          await this.bot.api.sendMessage(chat.chatId, text);
        } catch (error) {
          this.logger.warn(`Failed to announce meme to chat ${chat.chatId}: ${this.describeError(error)}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to announce meme', error);
    }
  }

  /** Список активных чатов (для диагностики). */
  public getActiveChats(): Promise<TrollChatEntity[]> {
    return this.chats.find({ where: { isActive: true } });
  }

  private async onMessage(ctx: BotContext): Promise<void> {
    const chat = ctx.chat;

    // Работаем только в группах и только для реальных пользователей.
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }
    if (!ctx.from || ctx.from.is_bot || !ctx.message) {
      return;
    }

    if (!(await this.isChatActive(chat.id))) {
      return;
    }

    const content = ctx.message.text ?? ctx.message.caption ?? null;
    const text = content?.trim() ?? '';

    // Команды не анализируем.
    if (text.startsWith('/')) {
      return;
    }

    const botId = ctx.me.id;
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === botId;
    const isMention = this.isBotMentioned(ctx, content);

    // Кто-то ответил боту или упомянул его — отвечаем максимально язвительно.
    if (isReplyToBot || isMention) {
      void this.replyAsJerk(ctx, content);
      return;
    }

    if (text.length < MIN_TEXT_LENGTH) {
      return;
    }

    // Проверка на признаки состава преступления (в фоне, чтобы не тормозить чат).
    void this.checkCriminalArticle(ctx, text);

    // Редкий язвительный подкол.
    if (Math.random() < this.config.trollSarcasmChance) {
      void this.replyWithSarcasm(ctx, content);
    }
  }

  private async checkCriminalArticle(ctx: BotContext, text: string): Promise<void> {
    const chatId = ctx.chat.id;

    if (this.analyzingChats.has(chatId)) {
      return;
    }
    this.analyzingChats.add(chatId);

    try {
      const assessment = await this.deepSeek.completeJson<CriminalAssessment>(
        CRIMINAL_ASSESSMENT_PROMPT,
        text,
        { temperature: 0.2, maxTokens: 700 }
      );

      if (!assessment || typeof assessment.probability !== 'number') {
        return;
      }

      const probability = Math.max(0, Math.min(1, assessment.probability));
      if (probability < this.config.trollCriminalThreshold) {
        return;
      }

      await this.safeReply(ctx, this.buildCriminalReply(assessment, probability), true);
    } finally {
      this.analyzingChats.delete(chatId);
    }
  }

  private async replyWithSarcasm(ctx: BotContext, content: string | null): Promise<void> {
    const text = await this.deepSeek.completeText(
      SARCASM_PROMPT,
      `${this.describeUser(ctx.from)} написал: ${content ?? '(без текста)'}`,
      { maxTokens: 160, temperature: 1.1 }
    );

    if (text) {
      await this.safeReply(ctx, text);
    }
  }

  private async replyAsJerk(ctx: BotContext, content: string | null): Promise<void> {
    const text = await this.deepSeek.completeText(
      JERK_PROMPT,
      `${this.describeUser(ctx.from)} написал: ${content ?? '(без текста)'}`,
      { maxTokens: 200, temperature: 1.15 }
    );

    if (text) {
      await this.safeReply(ctx, text);
    }
  }

  private buildCriminalReply(assessment: CriminalAssessment, probability: number): string {
    const percent = Math.round(probability * 100);
    const articles = Array.isArray(assessment.articles)
      ? assessment.articles.filter((article) => article && article.code)
      : [];

    const head =
      probability >= 0.8
        ? `⚖️ <b>Почти наверняка состав преступления</b> — ${percent}%`
        : `⚖️ <b>Похоже на статью</b> — ${percent}%`;

    const lines = [head];

    if (articles.length) {
      lines.push('', 'Возможные статьи:');
      for (const article of articles.slice(0, 3)) {
        const title = article.title ? ` — ${this.escapeHtml(article.title)}` : '';
        lines.push(`• <b>${this.escapeHtml(article.code)}</b>${title}`);
      }
    }

    if (assessment.reason) {
      lines.push('', `Почему: ${this.escapeHtml(assessment.reason)}`);
    }

    return lines.join('\n');
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

    if (isOutNow) {
      await this.chats.update({ chatId: chat.id }, { isActive: false });
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
    } catch (error) {
      this.logger.error(`Failed to notify owner about chat ${chatId}`, error);
    }
  }

  private async onOwnerDecision(ctx: BotContext): Promise<void> {
    if (!ctx.from || ctx.from.id !== this.config.ownerId) {
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
      await ctx.answerCallbackQuery('Подтверждено');
      await this.safeEditMessage(ctx, '✅ Бот активирован, теперь он работает в чате.');

      try {
        await this.bot.api.sendMessage(
          chatId,
          'Всем привет. Теперь я тут работаю. Постарайтесь не сморозить уголовщину 🤡'
        );
      } catch (error) {
        this.logger.warn(`Failed to greet chat ${chatId}: ${this.describeError(error)}`);
      }
      return;
    }

    await this.chats.update({ chatId }, { isActive: false });
    await ctx.answerCallbackQuery('Отклонено');
    await this.safeEditMessage(ctx, '❌ Бот не будет работать в этом чате.');

    try {
      await this.bot.api.leaveChat(chatId);
    } catch (error) {
      this.logger.warn(`Failed to leave chat ${chatId}: ${this.describeError(error)}`);
    }
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

  private isDaytime(): boolean {
    const hour = this.currentMoscowHour();
    return hour >= this.config.trollDaytimeStart && hour < this.config.trollDaytimeEnd;
  }

  private currentMoscowHour(): number {
    try {
      const formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Moscow',
        hour: 'numeric',
        hour12: false,
      }).format(new Date());
      const hour = parseInt(formatted, 10);
      if (Number.isNaN(hour)) {
        return new Date().getHours();
      }
      return hour === 24 ? 0 : hour;
    } catch {
      return new Date().getHours();
    }
  }

  private async safeReply(ctx: BotContext, text: string, html = false): Promise<void> {
    try {
      await ctx.reply(text, {
        ...(html ? { parse_mode: 'HTML' as const } : {}),
        reply_to_message_id: ctx.message?.message_id,
      });
    } catch (error) {
      this.logger.warn(`Failed to send troll reply: ${this.describeError(error)}`);
    }
  }

  private async safeEditMessage(ctx: BotContext, text: string): Promise<void> {
    try {
      await ctx.editMessageText(text);
    } catch (error) {
      this.logger.warn(`Failed to edit owner message: ${this.describeError(error)}`);
    }
  }

  private describeUser(from: User): string {
    const parts = [from.first_name, from.last_name].filter((value) => !!value);
    const name = parts.join(' ') || 'Аноним';
    return from.username ? `${name} (@${from.username})` : name;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
