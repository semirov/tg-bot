const mockBotUse = jest.fn();
const mockBotCatch = jest.fn();
const mockBotErrorBoundary = jest.fn();
const mockSetMyCommands = jest.fn();

jest.mock('grammy', () => {
  const actual = jest.requireActual('grammy');
  return {
    __esModule: true,
    ...actual,
    Bot: jest.fn().mockImplementation(function (this: any) {
      this.api = { setMyCommands: mockSetMyCommands };
      this.use = mockBotUse;
      this.catch = mockBotCatch;
      this.errorBoundary = mockBotErrorBoundary;
    }),
    session: jest.fn(() => jest.fn()),
  };
});

jest.mock('@grammyjs/conversations', () => ({ conversations: jest.fn(() => jest.fn()) }));
jest.mock('@grammyjs/runner', () => ({
  run: jest.fn(),
  sequentialize: jest.fn(() => jest.fn()),
}));
jest.mock('@grammyjs/storage-typeorm', () => ({
  TypeormAdapter: jest.fn().mockImplementation(function (this: any, options: any) {
    this.options = options;
  }),
}));

import { Logger } from '@nestjs/common';
import { Bot, session, BotError, GrammyError, HttpError } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { TypeormAdapter } from '@grammyjs/storage-typeorm';
import { BOT, BOT_PROVIDER, installResiliencePlugins } from './bot.provider';

function setup() {
  const config = { botToken: '123:ABC', tgEnv: 'test', ownerId: 1 } as any;
  const configMiddleware = { configMiddleware: jest.fn(() => jest.fn()) } as any;
  const repository = { findOne: jest.fn(), save: jest.fn() } as any;
  const sessionManagerService = { getRepository: jest.fn(() => repository) } as any;
  return { config, configMiddleware, sessionManagerService, repository };
}

const runFactory = (mocks = setup()) =>
  BOT_PROVIDER.useFactory(mocks.config, mocks.configMiddleware, mocks.sessionManagerService);

describe('BOT_PROVIDER', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMyCommands.mockResolvedValue(undefined);
  });

  it('экспортирует токен BOT', () => {
    expect(BOT).toBe('APP_BOT_TOKEN');
  });

  it('создаёт бота, настраивает сессию, команды и запускает runner', async () => {
    const mocks = setup();
    const bot = await runFactory(mocks);

    expect(Bot).toHaveBeenCalledWith('123:ABC', { client: { environment: 'test' } });
    expect(bot).toBe((Bot as unknown as jest.Mock).mock.instances[0]);
    expect(run).toHaveBeenCalledWith(bot);

    expect(mocks.configMiddleware.configMiddleware).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManagerService.getRepository).toHaveBeenCalledTimes(1);
    expect(TypeormAdapter).toHaveBeenCalledWith({ repository: mocks.repository });

    expect(mockBotUse).toHaveBeenCalledTimes(6);
    expect(mockBotCatch).toHaveBeenCalledTimes(1);
    expect(mockBotErrorBoundary).toHaveBeenCalledTimes(1);

    expect(mockSetMyCommands).toHaveBeenCalledWith([
      { command: '/menu', description: 'Показать основное меню бота' },
      { command: 'stat', description: 'Сколько лет тюрьмы наговорил чат за сутки' },
      { command: 'future', description: 'Предсказание на день (раз в 12 часов)' },
      { command: 'meme', description: 'Репост мема из канала (раз в час)' },
      { command: 'sumarize', description: 'О чём говорили в чате (раз в час)' },
    ]);
  });

  it('инициализирует сессию дефолтными значениями', async () => {
    await runFactory();
    expect(session).toHaveBeenCalledTimes(1);
    const options = (session as unknown as jest.Mock).mock.calls[0][0];
    expect(options.initial()).toEqual({
      anonymousPublishing: false,
    });
  });

  it('не роняет приложение, если не удалось обновить список команд (Error)', async () => {
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    mockSetMyCommands.mockRejectedValueOnce(new Error('network down'));

    const bot = await runFactory();

    expect(warn).toHaveBeenCalledWith(
      'Не удалось обновить список команд: network down',
      'BotProvider'
    );
    expect(bot).toBeDefined();
    expect(run).toHaveBeenCalled();
  });

  it('стрингифицирует не-Error ошибку setMyCommands', async () => {
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    mockSetMyCommands.mockRejectedValueOnce('oops');

    await runFactory();

    expect(warn).toHaveBeenCalledWith(
      'Не удалось обновить список команд: oops',
      'BotProvider'
    );
  });

  describe('sequentialize', () => {
    it('возвращает ключи chat и from, отбрасывая undefined', async () => {
      await runFactory();
      const callback = (sequentialize as unknown as jest.Mock).mock.calls[0][0];

      expect(callback({ chat: { id: 10 }, from: { id: 20 } })).toEqual(['10', '20']);
      expect(callback({ chat: { id: 10 } })).toEqual(['10']);
      expect(callback({ from: { id: 20 } })).toEqual(['20']);
      expect(callback({})).toEqual([]);
    });
  });

  describe('логирующая мидлварь', () => {
    it('пишет лог для channel_post и вызывает next', async () => {
      await runFactory();
      const middleware = mockBotUse.mock.calls[2][0];
      const log = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware({ channelPost: { chat: { id: 5 } } }, next);

      expect(log).toHaveBeenCalledWith(
        '[BOT_PROVIDER] Received channel_post update from chat 5',
        'BotProvider'
      );
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('без channel_post просто вызывает next', async () => {
      await runFactory();
      const middleware = mockBotUse.mock.calls[2][0];
      const log = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
      const next = jest.fn().mockResolvedValue(undefined);

      await middleware({}, next);

      expect(log).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('бан-мидлварь', () => {
    it('не пускает забаненного пользователя дальше', async () => {
      await runFactory();
      const middleware = mockBotUse.mock.calls[3][0];
      const next = jest.fn();

      await middleware({ config: { user: { isBanned: true } } }, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('пускает незабаненного и не падает без config', async () => {
      await runFactory();
      const middleware = mockBotUse.mock.calls[3][0];
      const next = jest.fn();

      await middleware({ config: { user: { isBanned: false } } }, next);
      await middleware({}, next);

      expect(next).toHaveBeenCalledTimes(2);
    });
  });

  describe('catch-обработчик', () => {
    const ctx = { update: { update_id: 99 } } as any;

    it('глушит безобидную Telegram 400 и пишет debug', async () => {
      await runFactory();
      const handler = mockBotCatch.mock.calls[0][0];
      const debug = jest.spyOn(Logger, 'debug').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const grammy = new GrammyError(
        'boom',
        { ok: false, error_code: 400, description: 'message is not modified' },
        'editMessageText',
        {}
      );

      handler(new BotError(grammy, ctx));

      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('Ignored benign Telegram error while handling update 99'),
        'BotProvider'
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('логирует настоящую GrammyError с описанием', async () => {
      await runFactory();
      const handler = mockBotCatch.mock.calls[0][0];
      jest.spyOn(Logger, 'debug').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const grammy = new GrammyError(
        'boom',
        { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
        'sendMessage',
        {}
      );

      handler(new BotError(grammy, ctx));

      expect(error).toHaveBeenCalledWith(
        'Error while handling update 99:',
        grammy
      );
      expect(error).toHaveBeenCalledWith('Error in request:', 'Bad Request: chat not found');
    });

    it('логирует GrammyError с кодом не 400', async () => {
      await runFactory();
      const handler = mockBotCatch.mock.calls[0][0];
      const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const grammy = new GrammyError(
        'boom',
        { ok: false, error_code: 403, description: 'Forbidden' },
        'sendMessage',
        {}
      );

      handler(new BotError(grammy, ctx));

      expect(error).toHaveBeenCalledWith('Error in request:', 'Forbidden');
    });

    it('логирует HttpError как проблему связи', async () => {
      await runFactory();
      const handler = mockBotCatch.mock.calls[0][0];
      const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const httpError = new HttpError('network', new Error('socket'));

      handler(new BotError(httpError, ctx));

      expect(error).toHaveBeenCalledWith('Could not contact Telegram:', httpError);
      expect(error).not.toHaveBeenCalledWith('Error in request:', expect.anything());
    });

    it('логирует неизвестную ошибку', async () => {
      await runFactory();
      const handler = mockBotCatch.mock.calls[0][0];
      const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const unknown = new Error('weird');

      handler(new BotError(unknown, ctx));

      expect(error).toHaveBeenCalledWith('Unknown error: ', unknown, unknown);
    });
  });

  describe('errorBoundary', () => {
    it('логирует ошибку и продолжает цепочку', async () => {
      await runFactory();
      const handler = mockBotErrorBoundary.mock.calls[0][0];
      const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const next = jest.fn();
      const err = { message: 'boom', error: { code: 1 } };

      handler(err, next);

      expect(error).toHaveBeenCalledWith('boom', ['Bot'], err.error);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

describe('installResiliencePlugins', () => {
  it('в тестах плагины не ставит', () => {
    const bot: any = { api: { config: { use: jest.fn() } } };
    installResiliencePlugins(bot, 'test');
    expect(bot.api.config.use).not.toHaveBeenCalled();
  });

  it('в прод-режиме ставит throttler и auto-retry', () => {
    const bot: any = { api: { config: { use: jest.fn() } } };
    installResiliencePlugins(bot, 'production');
    expect(bot.api.config.use).toHaveBeenCalledTimes(2);
  });
});
});
