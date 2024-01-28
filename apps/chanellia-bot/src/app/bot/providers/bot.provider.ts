import {Bot, BotError, GrammyError, HttpError, session} from 'grammy';
import {BaseConfigService} from '../../config/base-config.service';
import {BotConfigMiddleware} from './bot-config.middleware';
import {TypeormAdapter} from '@grammyjs/storage-typeorm';
import {BotContext, SessionDataInterface} from '../interfaces/bot-context.interface';
import {conversations} from '@grammyjs/conversations';
import {Logger} from '@nestjs/common';
import {run, sequentialize} from '@grammyjs/runner';
import {SessionManagerService} from '../services/session-manager.service';

export const LIGHT_HOUSE_BOT = 'APP_LIGHT_HOUSE_BOT_TOKEN';

const initialSessionData: SessionDataInterface = {
  test: true,
};

export const LIGHT_HOUSE_BOT_PROVIDER = {
  provide: LIGHT_HOUSE_BOT,
  useFactory: async (
    config: BaseConfigService,
    configMiddleware: BotConfigMiddleware,
    sessionManagerService: SessionManagerService
  ) => {
    if (config.runMode !== 'core') {
      return;
    }


    const bot = new Bot(config.botToken);

    bot.use(
      sequentialize((ctx) => {
        const chat = ctx.chat?.id.toString();
        const user = ctx.from?.id.toString();
        return [chat, user].filter((con) => con !== undefined);
      })
    );

    bot.use(configMiddleware.configMiddleware());

    bot.use(
      session({
        initial: () => ({...initialSessionData}),
        getSessionKey: (ctx: BotContext) => {
          return [ctx?.me?.id, ctx?.from?.id].filter(Boolean).join('_');
        },
        storage: new TypeormAdapter({
          repository: sessionManagerService.getRepository(),
        }),
      })
    );

    await bot.use(conversations());
    await bot.api.setMyCommands([
      {
        command: '/bots',
        description: 'Мои боты',
      },
      {
        command: '/add_bot',
        description: 'Подключить бота',
      },
    ]);

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

    run(bot);

    return bot;
  },
  inject: [BaseConfigService, BotConfigMiddleware, SessionManagerService],
};
