import { conversations } from '@grammyjs/conversations';
import { run, sequentialize } from '@grammyjs/runner';
import { TypeormAdapter } from '@grammyjs/storage-typeorm';
import { Logger } from '@nestjs/common';
import { Bot, BotError, GrammyError, HttpError, session } from 'grammy';
import { NextFunction } from 'grammy/out/composer';
import { BaseConfigService } from '../../config/base-config.service';
import { BotContext, SessionDataInterface } from '../interfaces/bot-context.interface';
import { SessionManagerService } from '../session/session-manager.service';
import { BotConfigMiddleware } from './bot-config.middleware';

export const BOT = 'APP_BOT_TOKEN';

/**
 * Ошибки Telegram 400, которые ничего не ломают (двойной клик по меню, гонка
 * при редактировании сообщения, удалённое сообщение). Их пишем в debug, иначе
 * они заливают лог стеками.
 */
const BENIGN_TELEGRAM_400 = [
  /message is not modified/i,
  /message to (edit|delete) not found/i,
  /message can't be (edited|deleted)/i,
  /query is too old/i,
];

function isBenignTelegramError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    BENIGN_TELEGRAM_400.some((pattern) => pattern.test(error.description))
  );
}

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
    const bot = new Bot(config.botToken, { client: { environment: config.tgEnv } });

    bot.catch((err: BotError<BotContext>) => {
      const ctx = err.ctx;
      const e = err.error;
      if (isBenignTelegramError(e)) {
        Logger.debug(
          `Ignored benign Telegram error while handling update ${ctx.update.update_id}: ${err.message}`,
          'BotProvider'
        );
        return;
      }
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

    bot.use(
      sequentialize((ctx) => {
        const chat = ctx.chat?.id.toString();
        const user = ctx.from?.id.toString();
        return [chat, user].filter((con) => con !== undefined);
      })
    );

    bot.use(configMiddleware.configMiddleware());

    // Логирование всех обновлений для отладки
    bot.use(async (ctx, next) => {
      if (ctx.channelPost) {
        Logger.log(
          `[BOT_PROVIDER] Received channel_post update from chat ${ctx.channelPost.chat.id}`,
          'BotProvider'
        );
      }
      await next();
    });

    bot.use(async (ctx: BotContext, next) => {
      if (ctx.config?.user?.isBanned) {
        return;
      }
      await next();
    });

    bot.use(
      session({
        initial: () => ({ ...initialSessionData }),
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
      {
        command: 'stat',
        description: 'Сколько лет тюрьмы наговорил чат за сутки',
      },
      {
        command: 'future',
        description: 'Предсказание на день (раз в 12 часов)',
      },
      {
        command: 'meme',
        description: 'Репост мема из канала (раз в час)',
      },
      {
        command: 'sumarize',
        description: 'О чём говорили в чате (раз в час)',
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
