import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { BaseConfigService } from '../../config/base-config.service';
import { BOT } from '../../bot/providers/bot.provider';
import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { Conversation, createConversation } from '@grammyjs/conversations';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientSessionEntity } from '../entities/client-session.entity';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import * as bigInt from 'big-integer';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class ClientBaseService implements OnModuleInit {
  constructor(
    private baseConfigService: BaseConfigService,
    @Inject(BOT) private bot: Bot<BotContext>,
    @InjectRepository(ClientSessionEntity)
    private userRequestRepository: Repository<ClientSessionEntity>
  ) {}

  private phoneSubject = new Subject<string>();
  private passwordSubject = new Subject<string>();
  private phoneCodeSubject = new Subject<string>();
  private telegramClient: TelegramClient;

  private observerChannelPostSubject = new Subject<BotContext>();

  async onModuleInit(): Promise<void> {
    this.registerConversations();
    this.waitingClientCommands();
    this.onObserverChannelPost();
    await this.checkAutoRunObserver();
  }

  public get observerChannelPost$(): Observable<BotContext> {
    return this.observerChannelPostSubject.asObservable();
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
          await event.message.forwardTo(
            bigInt(this.baseConfigService.observerChannel)
          );
        }
        this.lastProcessedGroup = undefined;
      }, 800) // Оптимальная задержка для альбомов
    };

    return true;
  }

  private async onMessageEvent(event: NewMessageEvent) {
    if (!event.isChannel) return;

    // Пропускаем сообщения из собственных каналов
    const ownChannels = [
      this.baseConfigService.memeChanelId,
      this.baseConfigService.cringeMemeChannelId,
      this.baseConfigService.observerChannel,
      this.baseConfigService.bestMemeChanelId
    ].map(id => bigInt(id));

    if (ownChannels.some(channelId => channelId.equals(event.chatId))) {
      return;
    }

    // Пытаемся обработать как альбом
    if (await this.handleAlbum(event)) return;

    // Одиночное сообщение
    if (!(await this.isAdPost(event))) {
      setTimeout(
        () => event.message.forwardTo(bigInt(this.baseConfigService.observerChannel)),
        Math.round(Math.random() * 5 + 5) * 1000
      );
    }
  }

  private onObserverChannelPost() {
    this.bot.on(['channel_post:photo', 'channel_post:video'], async (ctx) => {
      if (ctx.channelPost.sender_chat.id !== this.baseConfigService.observerChannel) {
        return;
      }
      this.observerChannelPostSubject.next(ctx);
    });
  }

  private async isAdPost(event: NewMessageEvent): Promise<boolean> {
    // Проверяем наличие ссылок
    const hasLinks = await this.isPostWithLinks(event);
    if (!hasLinks) return false;

    const message = event.message.message;
    if (!message) return false;

    // Получаем все ссылки из сообщения
    const urls = await this.extractUrls(event);
    if (urls.length === 0) return false;

    // Получаем информацию о текущем канале
    const currentChannel = await this.telegramClient.getEntity(event.chatId);

    // Проверяем каждую ссылку
    for (const url of urls) {
      try {
        const resolved = await this.resolveUrl(url);

        // Если ссылка ведет не на текущий канал - считаем рекламой
        if (!this.isSameChannel(resolved, currentChannel)) {
          return true;
        }
      } catch (error) {
        Logger.error(`Error resolving URL ${url}: ${error}`, ClientBaseService.name);
        // Если не удалось разрешить URL, считаем что это внешняя ссылка
        return true;
      }
    }

    return false;
  }

  @Cron(CronExpression.EVERY_DAY_AT_9PM)
  public async scheduleDailyBestPost() {
    try {
      Logger.log('Starting daily best post selection', ClientBaseService.name);
      await this.postDailyBestMeme();
    } catch (error) {
      Logger.error(`Error in daily best post: ${error}`, ClientBaseService.name);
    }
  }

  public async postDailyBestMeme() {
    if (!this.telegramClient?.connected) {
      Logger.warn('Telegram client is not connected for daily best post', ClientBaseService.name);
      return;
    }

    try {
      // Получаем сущность канала с мемами
      const memeChannel = await this.telegramClient.getEntity(
        bigInt(this.baseConfigService.memeChanelId)
      );

      // Получаем сообщения за последние 24 часа
      const messages = await this.telegramClient.getMessages(memeChannel, {
        limit: 100,
        offsetDate: Math.floor(Date.now() / 1000) - 86400 // 24 часа назад
      });

      if (messages.length === 0) {
        Logger.log('No messages found in meme channel for last 24h', ClientBaseService.name);
        return;
      }

      // Находим сообщение с максимальным engagement (просмотры + реакции)
      let bestMessage = null;
      let maxEngagement = 0;

      for (const message of messages) {
        if (!message) continue;

        // Получаем количество просмотров
        const views = message.views || 0;

        // Получаем количество реакций
        let reactionsCount = 0;
        if (message.reactions) {
          reactionsCount = message.reactions.results
            .reduce((sum, reaction) => sum + reaction.count, 0);
        }

        const engagement = views + reactionsCount;

        if (engagement > maxEngagement) {
          maxEngagement = engagement;
          bestMessage = message;
        }
      }

      if (bestMessage) {
        Logger.log(`Posting best message with engagement ${maxEngagement}`, ClientBaseService.name);

        // Пересылаем через бота
        await this.bot.api.copyMessage(
          this.baseConfigService.bestMemeChanelId,
          this.baseConfigService.memeChanelId,
          bestMessage.id
        );
      } else {
        Logger.log('No suitable message found to post', ClientBaseService.name);
      }
    } catch (error) {
      Logger.error(`Error posting daily best meme: ${error}`, ClientBaseService.name);

      // Дополнительная обработка ошибок
      if (error.message.includes('Could not find the input entity')) {
        Logger.error('Make sure the bot has access to both channels', ClientBaseService.name);
      } else if (error.message.includes('message to forward not found')) {
        Logger.error('The message may have been deleted', ClientBaseService.name);
      }

      throw error;
    }
  }

  private async extractUrls(event: NewMessageEvent): Promise<string[]> {
    const urls: string[] = [];
    const message = event.message;

    if (!message.entities) return urls;

    for (const entity of message.entities) {
      if (entity instanceof Api.MessageEntityUrl) {
        const offset = entity.offset;
        const length = entity.length;
        urls.push(message.message.substring(offset, offset + length));
      } else if (entity instanceof Api.MessageEntityTextUrl) {
        urls.push(entity.url);
      }
    }

    return urls;
  }

  private async resolveUrl(url: string): Promise<any> {
    // Telegram может возвращать сокращенные ссылки (t.me/xxx)
    // Нужно раскрыть их до полного URL
    if (url.startsWith('t.me/')) {
      url = `https://${url}`;
    }

    // Для Telegram ссылок используем getEntity
    if (url.includes('t.me/')) {
      const username = url.split('t.me/')[1].split('/')[0];
      return await this.telegramClient.getEntity(username);
    }

    // Для других ссылок можно использовать HTTP запрос
    // (но нужно учитывать редиректы)
    // Здесь простейшая реализация - в реальном коде нужно обрабатывать редиректы
    return { isExternal: true, url };
  }

  private isSameChannel(resolvedEntity: any, currentChannel: any): boolean {
    // Если это внешний URL (не Telegram)
    if (resolvedEntity.isExternal) {
      return false;
    }

    // Сравниваем ID каналов
    if (resolvedEntity.id && currentChannel.id) {
      return resolvedEntity.id.equals(currentChannel.id);
    }

    // Сравниваем usernames каналов
    if (resolvedEntity.username && currentChannel.username) {
      return resolvedEntity.username.toLowerCase() === currentChannel.username.toLowerCase();
    }

    return false;
  }

  private async isPostWithLinks(event: NewMessageEvent) {
    const caption = event?.message?.message;
    const entities = event?.message?.entities || [];

    if (!caption) {
      return false;
    }

    for (const entity of entities) {
      switch (true) {
        case entity instanceof Api.MessageEntityUrl:
        case entity instanceof Api.MessageEntityTextUrl: {
          return true;
        }
      }
    }
    return false;
  }
}
