import { Conversation, createConversation } from '@grammyjs/conversations';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import * as bigInt from 'big-integer';
import { Bot, InlineKeyboard } from 'grammy';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { StringSession } from 'telegram/sessions';
import { Repository } from 'typeorm';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BOT } from '../../bot/providers/bot.provider';
import { BaseConfigService } from '../../config/base-config.service';
import { ClientSessionEntity } from '../entities/client-session.entity';
import { AdDetector, ResolvedChannelEntity } from '../domain/ad-detector';

export type BestMemeContext = {
  byViewPostMemeId?: number;
  byLikePostMemeId?: number;
  byViewPostBestMemeId?: number;
  byLikePostBestMemeId?: number;
};

@Injectable()
export class ClientBaseService implements OnModuleInit {
  constructor(
    private baseConfigService: BaseConfigService,
    @Inject(BOT) private bot: Bot<BotContext>,
    @InjectRepository(ClientSessionEntity)
    private userRequestRepository: Repository<ClientSessionEntity>
  ) {}

  /** Чистая детекция рекламы (вынесена из god-class). */
  private readonly adDetector = new AdDetector();

  private phoneSubject = new Subject<string>();
  private passwordSubject = new Subject<string>();
  private phoneCodeSubject = new Subject<string>();
  private telegramClient: TelegramClient;

  private bestMemesDailytSubject = new Subject<BestMemeContext>();

  /** Промис-кэш адресата форварда: личка главного бота. */
  private botForwardTarget?: Promise<string | undefined>;

  async onModuleInit(): Promise<void> {
    this.registerConversations();
    this.waitingClientCommands();
    await this.checkAutoRunObserver();
  }

  public get bestMemesDaily$(): Observable<BestMemeContext> {
    return this.bestMemesDailytSubject.asObservable();
  }

  public async toggleChannelObserver(): Promise<void> {
    const status = await this.lastObserverStatus();
    if (status) {
      await this.stopObserverStation();
    } else {
      await this.startChannelObserver();
    }
  }

  private async stopObserverStation() {
    if (this.telegramClient.connected) {
      await this.telegramClient.destroy();
    }
    await this.changeObserverState(false);
  }

  private async startChannelObserver() {
    const loadedOrEmptySession = await this.loadSession();
    this.telegramClient = new TelegramClient(
      loadedOrEmptySession,
      this.baseConfigService.appApiId,
      this.baseConfigService.appApiHash,
      {
        connectionRetries: 5,
        autoReconnect: true,
      }
    );

    this.telegramClient
      .start({
        phoneNumber: async () => {
          return await this.getPhoneNumber();
        },
        password: async () => {
          return await this.getPassword();
        },
        phoneCode: async () => {
          return await this.getPhoneCode();
        },
        onError: (err) => Logger.error(err, ClientBaseService.name),
      })
      .then(() => {
        const session = loadedOrEmptySession.save();
        this.saveSession(session);
        Logger.log('Observer station started', ClientBaseService.name);
      });
    await this.changeObserverState(true);

    this.telegramClient.addEventHandler(async (event) => {
      this.onMessageEvent(event);
    }, new NewMessage({}));
  }

  private async getPhoneNumber(): Promise<string> {
    const inlineKeyboard = new InlineKeyboard().text('Указать телефон', 'fill_client_phone');
    await this.bot.api.sendMessage(
      this.baseConfigService.ownerId,
      'Нужен номер телефона для запуска клиента',
      { reply_markup: inlineKeyboard }
    );
    return firstValueFrom(this.phoneSubject);
  }

  private async getPassword(): Promise<string> {
    const inlineKeyboard = new InlineKeyboard().text('Указать пароль', 'fill_client_password');
    await this.bot.api.sendMessage(
      this.baseConfigService.ownerId,
      'Нужен пароль для запуска клиента',
      { reply_markup: inlineKeyboard }
    );
    return firstValueFrom(this.passwordSubject);
  }

  private async getPhoneCode(): Promise<string> {
    const inlineKeyboard = new InlineKeyboard().text('Указать код', 'fill_client_code');
    await this.bot.api.sendMessage(
      this.baseConfigService.ownerId,
      'Нужен код подтверждения для запуска клиента',
      { reply_markup: inlineKeyboard }
    );
    return firstValueFrom(this.phoneCodeSubject);
  }

  public async phoneConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply('Введи номер телефона');
    const answerCtx = await conversation.wait();
    if (answerCtx?.message?.text) {
      this.phoneSubject.next(answerCtx?.message?.text);
    }
    return;
  }

  public async passwordConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply('Введи пароль');
    const answerCtx = await conversation.wait();
    if (answerCtx?.message?.text) {
      this.passwordSubject.next(answerCtx?.message?.text);
    }
    return;
  }

  public async phoneCodeConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply('Введи код подтверждения');
    const answerCtx = await conversation.wait();
    if (answerCtx?.message?.text) {
      this.phoneCodeSubject.next(answerCtx?.message?.text);
    }
    return;
  }

  private waitingClientCommands(): void {
    this.bot.callbackQuery('fill_client_phone', async (ctx) => {
      await ctx.conversation.enter('PHONE_CONVERSATION');
    });
    this.bot.callbackQuery('fill_client_password', async (ctx) => {
      await ctx.conversation.enter('PASSWORD_CONVERSATION');
    });
    this.bot.callbackQuery('fill_client_code', async (ctx) => {
      await ctx.conversation.enter('PHONE_CODE_CONVERSATION');
    });
  }

  private registerConversations() {
    this.bot.use(createConversation(this.phoneConversation.bind(this), 'PHONE_CONVERSATION'));
    this.bot.use(createConversation(this.passwordConversation.bind(this), 'PASSWORD_CONVERSATION'));
    this.bot.use(
      createConversation(this.phoneCodeConversation.bind(this), 'PHONE_CODE_CONVERSATION')
    );
  }

  private async saveSession(session: string): Promise<void> {
    await this.userRequestRepository.update({ station: 'main' }, { session });
  }

  public async lastObserverStatus(): Promise<boolean> {
    const settings = await this.userRequestRepository.findOne({ where: { station: 'main' } });

    return !!settings?.isActive;
  }

  private async changeObserverState(status: boolean): Promise<void> {
    await this.userRequestRepository.update({ station: 'main' }, { isActive: status });
  }

  private async loadSession(): Promise<StringSession> {
    const session = await this.userRequestRepository.findOne({ where: { station: 'main' } });
    if (!session) {
      return new StringSession('');
    }

    return new StringSession(session.session);
  }

  private async checkAutoRunObserver(): Promise<void> {
    const hasSession = await this.userRequestRepository.countBy({ station: 'main' });
    if (!hasSession) {
      const value = await this.userRequestRepository.create({
        station: 'main',
        session: '',
        isActive: false,
      });
      await this.userRequestRepository.save(value);
    }

    const lastStatus = await this.lastObserverStatus();

    if (lastStatus) {
      await this.startChannelObserver();
    } else {
      Logger.log('Observer not started', ClientBaseService.name);
    }
  }

  private lastProcessedGroup?: {
    id: string;
    timer: NodeJS.Timeout;
  };

  private async handleAlbum(event: NewMessageEvent) {
    if (!event.message.groupedId) return false;

    const groupId = event.message.groupedId.toString();

    // Если уже обрабатывается эта группа
    if (this.lastProcessedGroup?.id === groupId) {
      clearTimeout(this.lastProcessedGroup.timer);
    }

    // Устанавливаем новый таймер
    this.lastProcessedGroup = {
      id: groupId,
      timer: setTimeout(async () => {
        if (!(await this.isAdPost(event))) {
          await this.forwardToBot(event);
        }
        this.lastProcessedGroup = undefined;
      }, 800), // Оптимальная задержка для альбомов
    };

    return true;
  }

  private async onMessageEvent(event: NewMessageEvent) {
    if (!event.isChannel) return;

    const hasMedia = !!event.message && this.hasMediaContent(event.message);
    Logger.debug(
      `Parser: channel message chat=${event.chatId} msg=${event.message?.id} media=${hasMedia} grouped=${!!event.message?.groupedId}`,
      ClientBaseService.name
    );

    // Пропускаем сообщения из собственных каналов
    const ownChannels = [
      this.baseConfigService.memeChanelId,
      this.baseConfigService.cringeMemeChannelId,
      this.baseConfigService.bestMemeChanelId,
      this.baseConfigService.userRequestMemeChannel,
    ].map((id) => bigInt(id));

    if (ownChannels.some((channelId) => channelId.equals(event.chatId))) {
      Logger.debug(`Parser: skip own channel ${event.chatId}`, ClientBaseService.name);
      return;
    }

    // Парсер интересуют только медиапосты (фото/видео, в т.ч. альбомы).
    if (!hasMedia) return;

    // Пытаемся обработать как альбом
    if (await this.handleAlbum(event)) return;

    // Одиночное сообщение
    if (await this.isAdPost(event)) {
      Logger.debug(`Parser: skip ad post chat=${event.chatId}`, ClientBaseService.name);
      return;
    }
    setTimeout(() => this.forwardToBot(event), Math.round(Math.random() * 5 + 5) * 1000);
  }

  /**
   * Форвардит найденный пост в личку главному боту.
   *
   * Раньше пост уходил в отдельный канал-коллектор, а бот ловил там
   * `channel_post`. Теперь коллектор не нужен: бот принимает форвард в личке
   * (см. `ObservatoryService`) и сам кладёт пост в предложку. Личный аккаунт
   * по-прежнему делает write-операцию, поэтому read-only/загрузку ботом
   * вынесем отдельным этапом (TGB-DOC-5).
   */
  private async forwardToBot(event: NewMessageEvent): Promise<void> {
    try {
      const target = await this.resolveBotForwardTarget();
      if (!target) {
        return;
      }
      await event.message.forwardTo(target);
      Logger.log(
        `Parser: post forwarded to bot (chat=${event.chatId}, msg=${event.message?.id})`,
        ClientBaseService.name
      );
    } catch (error) {
      Logger.error(`Cannot forward parsed post to bot: ${error}`, ClientBaseService.name);
    }
  }

  /**
   * Возвращает адресата форварда парсера — главного бота (`@username`).
   *
   * Резолв идёт один раз за процесс: кэшируется промис, чтобы параллельные
   * посты не дёргали `getMe` повторно. Если у бота нет username — форвардить
   * некуда, пишем ошибку и пропускаем. Неудачный резолв не кэшируется:
   * следующий пост попробует снова.
   */
  private resolveBotForwardTarget(): Promise<string | undefined> {
    if (!this.botForwardTarget) {
      this.botForwardTarget = this.bot.api
        .getMe()
        .then((me) => {
          if (!me.username) {
            Logger.error(
              'Главный бот без username — парсеру некуда форвардить посты',
              ClientBaseService.name
            );
            return undefined;
          }
          Logger.log(
            `Parser: forward target resolved to @${me.username}`,
            ClientBaseService.name
          );
          return `@${me.username}`;
        })
        .catch((error) => {
          this.botForwardTarget = undefined;
          throw error;
        });
    }
    return this.botForwardTarget;
  }

  /**
   * Тонкая обёртка над `AdDetector.isAdPost`.
   *
   * Через порт коллабораторов сохраняются точки подмены `isPostWithLinks`,
   * `extractUrls`, `resolveUrl` и `isSameChannel`, на которые опирается
   * существующая white-box спецификация.
   */
  private async isAdPost(event: NewMessageEvent): Promise<boolean> {
    const result = await this.adDetector.classifyPost(event, {
      isPostWithLinks: (messageEvent) => this.isPostWithLinks(messageEvent),
      extractUrls: (messageEvent) => this.extractUrls(messageEvent),
      resolveUrl: (url) => this.resolveUrl(url),
      isSameChannel: (resolved, current) => this.isSameChannel(resolved, current),
      getCurrentChannel: (chatId) => this.telegramClient.getEntity(chatId),
      loggerContext: ClientBaseService.name,
    });

    if (result.isAd) {
      Logger.log(
        `Skip post as ad (${result.reason}): ${result.foreignLinks.join(', ')}`,
        ClientBaseService.name
      );
    }

    return result.isAd;
  }

  // 21:00 МСК
  @Cron(CronExpression.EVERY_DAY_AT_6PM)
  public async postDailyBestMeme(alternateChatId?: number) {
    const context: BestMemeContext = {};
    try {
      // Получаем сущность канала с мемами
      const memeChannel = await this.telegramClient.getEntity(
        bigInt(this.baseConfigService.memeChanelId)
      );

      // Рассчитываем временные рамки
      const now = Math.floor(Date.now() / 1000);
      const twentyFourHoursAgo = now - 86400;

      // Получаем сообщения с конца (новые сначала)
      const messages = await this.telegramClient.getMessages(memeChannel, {
        limit: 100, // Достаточно для покрытия 24 часов в активном канале
      });

      if (messages.length === 0) {
        Logger.log('No messages found in meme channel', ClientBaseService.name);
        return;
      }

      // Фильтруем сообщения за последние 24 часа
      const recentMessages = messages.filter(
        (msg) => msg.date && msg.date >= twentyFourHoursAgo && this.hasMediaContent(msg)
      );

      if (recentMessages.length === 0) {
        Logger.log(
          `Found ${messages.length} messages, but none in last 24 hours. Oldest message: ${new Date(
            messages[messages.length - 1].date * 1000
          )}`,
          ClientBaseService.name
        );
        return;
      }

      // Находим лучший пост по просмотрам
      let bestByViews = null;
      let maxViews = 0;

      // Находим лучший пост по реакциям
      let bestByReactions = null;
      let maxReactions = 0;

      for (const message of recentMessages) {
        if (!message) continue;

        // Обработка просмотров
        const views = message.views || 0;
        if (views > maxViews) {
          maxViews = views;
          bestByViews = message;
          context.byViewPostMemeId = message.id;
        }

        // Обработка реакций
        let reactionsCount = 0;
        if (message.reactions) {
          reactionsCount = message.reactions.results.reduce(
            (sum, reaction) => sum + reaction.count,
            0
          );
        }

        if (reactionsCount > maxReactions) {
          maxReactions = reactionsCount;
          bestByReactions = message;
          context.byLikePostMemeId = message.id;
        }
      }

      if (!bestByViews && !bestByReactions) {
        Logger.log('No suitable messages found to post', ClientBaseService.name);
        return;
      }

      // Проверяем, один ли это пост
      if (bestByViews?.id === bestByReactions?.id) {
        Logger.log(
          `Posting single best message with ${maxViews} views and ${maxReactions} reactions`,
          ClientBaseService.name
        );
        context.byViewPostBestMemeId = await this.copyMessage(
          bestByViews.id,
          false,
          alternateChatId
        );
      } else {
        if (bestByViews) {
          Logger.log(`Posting best by views: ${maxViews} views`, ClientBaseService.name);
          await this.copyMessage(bestByViews.id, true, alternateChatId);
        }
        if (bestByReactions) {
          Logger.log(
            `Posting best by reactions: ${maxReactions} reactions`,
            ClientBaseService.name
          );
          context.byLikePostBestMemeId = await this.copyMessage(
            bestByReactions.id,
            false,
            alternateChatId
          );
        }
      }
      if (!alternateChatId) {
        this.bestMemesDailytSubject.next(context);
      }
    } catch (error) {
      Logger.error(`Error posting daily best meme: ${error}`, ClientBaseService.name);
      this.bestMemesDailytSubject.next({ byLikePostMemeId: 37, byViewPostMemeId: 37 });
      throw error;
    }
  }

  private async copyMessage(
    messageId: number,
    silent: boolean,
    alternateChatId?: number
  ): Promise<number> {
    try {
      const message = await this.bot.api.copyMessage(
        alternateChatId || this.baseConfigService.bestMemeChanelId,
        this.baseConfigService.memeChanelId,
        messageId,
        {
          disable_notification: silent,
        }
      );
      return message.message_id;
    } catch (e) {
      Logger.error(`Cannot copy message ${messageId}`, ClientBaseService.name);
    }
  }

  /** Тонкая обёртка над `AdDetector.extractUrls`. */
  private extractUrls(event: NewMessageEvent): Promise<string[]> {
    return this.adDetector.extractUrls(event);
  }

  /** Тонкая обёртка над `AdDetector.hasMediaContent`. */
  private hasMediaContent(message: Api.Message): boolean {
    return this.adDetector.hasMediaContent(message);
  }

  /** Тонкая обёртка над `AdDetector.resolveUrl` с текущим MTProto-клиентом. */
  private resolveUrl(url: string): Promise<ResolvedChannelEntity> {
    return this.adDetector.resolveUrl(url, {
      getEntity: (entity) => this.telegramClient.getEntity(entity),
      checkInvite: (hash) => this.checkInvite(hash),
    });
  }

  /**
   * Резолвит invite-ссылку в чат через MTProto `messages.CheckChatInvite`.
   *
   * Ошибка резолва логируется и трактуется как внешняя ссылка (не свой канал).
   *
   * @param hash хеш приглашения из `t.me/+hash` / `joinchat`
   * @returns сущность чата или `undefined`
   */
  private async checkInvite(hash: string): Promise<ResolvedChannelEntity | undefined> {
    try {
      const result = await this.telegramClient.invoke(
        new Api.messages.CheckChatInvite({ hash })
      );
      return (result as { chat?: ResolvedChannelEntity })?.chat;
    } catch (error) {
      Logger.error(
        `Error checking invite ${hash}: ${error}`,
        ClientBaseService.name
      );
      return undefined;
    }
  }

  /** Тонкая обёртка над `AdDetector.isSameChannel`. */
  private isSameChannel(
    resolvedEntity: ResolvedChannelEntity,
    currentChannel: ResolvedChannelEntity
  ): boolean {
    return this.adDetector.isSameChannel(resolvedEntity, currentChannel);
  }

  /** Тонкая обёртка над `AdDetector.isPostWithLinks`. */
  private isPostWithLinks(event: NewMessageEvent): Promise<boolean> {
    return this.adDetector.isPostWithLinks(event);
  }
}
