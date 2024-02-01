import {Injectable, Logger, Scope} from '@nestjs/common';
import {Bot, BotError, GrammyError, HttpError, session} from 'grammy';
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
import {MessageHandler} from "../services/message.handler";
import {ClientEntityInterface} from "@chanellia/common";

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
    private messageHandler: MessageHandler,
  ) {
  }

  private botInstance: Bot<ManagedBotContext>;
  private me: ManagedBotContext['me'];
  private runnerHandle: RunnerHandle;
  private clientEntity: ClientEntityInterface;

  public async createBot(clientEntity: ClientEntityInterface): Promise<Bot<ManagedBotContext>> {
    const bot = new Bot<ManagedBotContext>(clientEntity.botToken);

    await bot.use(this.prepareSequentialize());
    await bot.use(this.configMiddleware(clientEntity.adminUserId));
    await bot.use(this.prepareSessionManager());
    await bot.use(conversations());
    await bot.api.setMyCommands([
      {
        command: '/menu',
        description: 'Основное меню',
      },
    ]);

    bot.catch((err: BotError<ManagedBotContext>) => {
      const ctx = err.ctx;
      const e = err.error;
      if (e instanceof GrammyError) {
        Logger.error(
          `Error in bot @${ctx.me.username} (id: ${ctx.me.id})`,
          e.description,
          BotsFactory.name
        );
      } else if (e instanceof HttpError) {
        Logger.error('Could not contact Telegram:', e, BotsFactory.name);
      } else {
        Logger.error('Unknown error: ', err, BotsFactory.name);
      }
    });

    this.runnerHandle = run(bot);
    this.botInstance = bot;
    this.clientEntity = clientEntity;
    this.me = await this.botInstance.api.getMe();
    this.initHandlers();

    return bot;
  }

  private prepareSessionManager() {
    return session({
      initial: () => ({}),
      getSessionKey: (ctx: ManagedBotContext) => {
        return [ctx?.me?.id, ctx?.from?.id].filter(Boolean).join('_');
      },
      storage: new TypeormAdapter({
        repository: this.botsSessionRepository,
      }),
    });
  }

  private prepareSequentialize() {
    return sequentialize((ctx: ManagedBotContext) => {
      const chat = ctx.chat?.id.toString();
      const user = ctx.from?.id.toString();
      return [chat, user].filter((con) => con !== undefined);
    });
  }

  private configMiddleware(ownerId: number): Middleware {
    return async (ctx: ManagedBotContext, next: NextFunction) => {
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
      await next();
    };
  }

  private initHandlers(): void {
    this.messageHandler.initHandler(this.botInstance);
  }
}
