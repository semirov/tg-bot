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

  private async onMessageEvent(event: NewMessageEvent) {
    if (!event.isChannel) {
      return;
    }

    setTimeout(
      () => event.message.forwardTo(bigInt(this.baseConfigService.observerChannel)),
      Math.round(Math.random() * 5 + 5) * 1000
    );
  }

  private onObserverChannelPost() {
    this.bot.on(['channel_post:photo', 'channel_post:video'], async (ctx) => {
      if (ctx.channelPost.sender_chat.id !== this.baseConfigService.observerChannel) {
        return;
      }
      this.observerChannelPostSubject.next(ctx);
    });
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
