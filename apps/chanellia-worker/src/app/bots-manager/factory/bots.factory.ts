import {Injectable, Logger, Scope} from '@nestjs/common';
import {Bot, BotError, Context, GrammyError, HttpError, session} from 'grammy';
import {run, sequentialize} from '@grammyjs/runner';
import {TypeormAdapter} from '@grammyjs/storage-typeorm';
import {conversations} from '@grammyjs/conversations';
import {Middleware, NextFunction} from 'grammy/out/composer';
import {ManagedBotContext} from '../interfaces/managed-bot-context.interface';
import {InjectRepository} from '@nestjs/typeorm';
import {BotsSessionEntity} from '../entities/bots-session.entity';
import {Repository} from 'typeorm';
import {BotsUsersEntity} from '../entities/bots-users.entity';
import {RunnerHandle} from '@grammyjs/runner/out/runner';
import {MessageHandler} from '../services/message.handler';
import {BotEntityInterface} from '@chanellia/common';
import {autoRetry} from '@grammyjs/auto-retry';

/**
 * Создает каждого отдельного бота
 */
@Injectable({scope: Scope.TRANSIENT})
export class BotsFactory {
  constructor(
    @InjectRepository(BotsSessionEntity)
    private botsSessionRepository: Repository<BotsSessionEntity>,
    @InjectRepository(BotsUsersEntity)
    private botsUsersEntity: Repository<BotsUsersEntity>,
    private messageHandler: MessageHandler
  ) {
  }

  private botInstance: Bot<ManagedBotContext>;
  private me: ManagedBotContext['me'];
  private runnerHandle: RunnerHandle;
  private clientEntity: BotEntityInterface;

  public async removeBot(): Promise<void> {
    await this.runnerHandle.stop();
    this.botInstance = null;
    this.me = null;
    this.runnerHandle = null;
    this.clientEntity = null;
  }

  public async createBot(botEntity: BotEntityInterface): Promise<Bot<ManagedBotContext>> {
    const bot = new Bot<ManagedBotContext>(botEntity.botToken);
    await bot.use(this.prepareSessionManager());
    await bot.use(this.prepareSequentialize());
    await bot.use(this.prepareConfigMiddleware(botEntity.user.id));
    bot.api.config.use(autoRetry({maxDelaySeconds: 5, maxRetryAttempts: 3}));
    await bot.use(conversations());
    await bot.api.setMyCommands([
      {
        command: '/menu',
        description: 'Основное меню',
      },
    ]);

    bot.catch(this.prepareErrorHandler());

    this.runnerHandle = run(bot);
    this.botInstance = bot;
    this.clientEntity = botEntity;
    this.me = await this.botInstance.api.getMe();
    this.initHandlers();

    return bot;
  }


  private prepareSessionManager() {
    return session({
      initial: () => ({}),
      getSessionKey: this.sequentializeFn,
      storage: new TypeormAdapter({
        repository: this.botsSessionRepository,
      }),
    });
  }

  private prepareSequentialize() {
    return sequentialize(this.sequentializeFn);
  }

  private sequentializeFn = (ctx: Context) => {
    return [ctx?.me?.id, ctx?.chat?.id, ctx?.from?.id].filter(Boolean).join('_');
  };

  private prepareConfigMiddleware(ownerId: number): Middleware {
    return async (ctx: ManagedBotContext, next: NextFunction) => {
      if (!ctx?.me?.id || !ctx?.from?.id) {
        next();
      }
      const user = await this.botsUsersEntity.upsert(
        {
          botId: ctx.me?.id,
          userId: ctx.from?.id,
          lastActivity: new Date(),
        },
        ['botId', 'userId']
      );

      const rawUser: Partial<BotsUsersEntity> = Array.isArray(user.raw) && user.raw[0];

      ctx.config = {
        isOwner: ctx?.from?.id === ownerId,
        banned: rawUser.banned || false,
      };
      next();
    };
  }


  private prepareErrorHandler() {
    return (err: BotError<ManagedBotContext>) => {
      const ctx = err.ctx;
      const e = err.error;
      if (e instanceof GrammyError) {
        Logger.error(
          `Error in bot @${ctx.me.username} (id: ${ctx?.me?.id})`,
          e.description,
          BotsFactory.name
        );
      } else if (e instanceof HttpError) {
        Logger.error('Could not contact Telegram:', e, BotsFactory.name);
      } else {
        Logger.error('Unknown error: ', err, BotsFactory.name);
      }
    };
  }

  private initHandlers(): void {
    this.messageHandler.initHandler(this.botInstance);
  }
}
