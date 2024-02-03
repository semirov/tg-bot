import {Bot} from 'grammy';
import {BaseConfigService} from '../../config/base-config.service';
import {BotConfigMiddleware} from './bot-config.middleware';
import {conversations} from '@grammyjs/conversations';
import {autoRetry} from "@grammyjs/auto-retry";

export const CHANELLIA_BOT_INSTANCE = 'APP_LIGHT_HOUSE_BOT_TOKEN';

export const LIGHT_HOUSE_BOT_PROVIDER = {
  provide: CHANELLIA_BOT_INSTANCE,
  useFactory: async (
    config: BaseConfigService,
    configMiddleware: BotConfigMiddleware,
  ) => {
    const bot = new Bot(config.botToken);
    await bot.use(configMiddleware.prepareConfigMiddleware());
    await bot.use(configMiddleware.prepareSessionManager());
    await bot.use(configMiddleware.prepareSequentialize());
    await bot.use(conversations());
    await bot.api.config.use(autoRetry({maxDelaySeconds: 5, maxRetryAttempts: 3}));
    await bot.api.setMyCommands([
      {
        command: '/mybots',
        description: 'Мои боты',
      },
      {
        command: '/newbot',
        description: 'Подключить бота',
      },
    ]);

    bot.catch(configMiddleware.prepareErrorHandler());

    return bot;
  },
  inject: [BaseConfigService, BotConfigMiddleware],
};
