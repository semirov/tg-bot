import {Bot, BotError, GrammyError, HttpError, session} from 'grammy';
import {BaseConfigService} from '../../config/base-config.service';
import {BotConfigMiddleware} from './bot-config.middleware';
import {TypeormAdapter} from '@grammyjs/storage-typeorm';
import {SessionManagerService} from '../session/session-manager.service';
import {BotContext, SessionDataInterface} from '../interfaces/bot-context.interface';
import {conversations} from '@grammyjs/conversations';
import {Logger} from '@nestjs/common';
import {NextFunction} from 'grammy/out/composer';
import {run, sequentialize} from '@grammyjs/runner';

export const BOT = 'APP_BOT_TOKEN';

const initialSessionData: SessionDataInterface = {
  anonymousPublishing: false,
  canBeModeratePosts: true,
};

export const BOT_PROVIDER = {
  provide: BOT,
  useFactory: async (
    config: BaseConfigService,
    configMiddleware: BotConfigMiddleware,
    sessionManagerService: SessionManagerService
  ) => {
    const bot = new Bot(config.botToken);

    bot.catch((err: BotError<BotContext>) => {
      const ctx = err.ctx;
      const e = err.error;
      Logger.error(`Error while handling update ${ctx.update.update_id}:`, e);
      if (e instanceof GrammyError) {
        Logger.error('Error in request:', e.description);
      } else if (e instanceof HttpError) {
        Logger.error('Could not contact Telegram:', e);
      } else {
        Logger.error('Unknown error: ', e, e);
      }
      console.error(e);
    });


    bot.use(sequentialize((ctx) => {
      const chat = ctx.chat?.id.toString();
      const user = ctx.from?.id.toString();
      return [chat, user].filter((con) => con !== undefined);
    }));

    bot.use(configMiddleware.configMiddleware());


    bot.use(async (ctx: BotContext, next) => {
      if (ctx.config?.user?.isBanned) {
        return;
      }
      await next();
    });

    bot.use(
      session({
        initial: () => ({...initialSessionData}),
        storage: new TypeormAdapter({
          repository: sessionManagerService.getRepository(),
        }),
      })
    );

    await bot.use(conversations());
    await bot.api.setMyCommands([
      {
        command: '/menu',
        description: 'Показать основное меню бота',
      },
    ]);

    bot.errorBoundary((err: BotError, next: NextFunction) => {
      Logger.error(err.message, ['Bot'], err.error);
      next();
    });

    run(bot);

    return bot;
  },
  inject: [BaseConfigService, BotConfigMiddleware, SessionManagerService],
};
