import { Bot } from 'grammy';

import { metrics } from '../../shared/metrics';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { BotTelemetryService, telegramUpdateType } from './bot-telemetry.service';

const makeBot = () => {
  const use = jest.fn();
  const apiUse = jest.fn();
  const bot = { use, api: { config: { use: apiUse } } } as unknown as Bot<BotContext>;
  return { bot, use, apiUse };
};

describe('BotTelemetryService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('telegramUpdateType распознаёт типы', () => {
    expect(telegramUpdateType(undefined)).toBe('unknown');
    expect(telegramUpdateType({ message: {} })).toBe('message');
    expect(telegramUpdateType({ callback_query: {} })).toBe('callback_query');
    expect(telegramUpdateType({ channel_post: {} })).toBe('channel_post');
    expect(telegramUpdateType({ chat_join_request: {} })).toBe('chat_join_request');
    expect(telegramUpdateType({ weird: true })).toBe('other');
  });

  it('onModuleInit ставит middleware и трансформер API', () => {
    const { bot, use, apiUse } = makeBot();
    new BotTelemetryService(bot).onModuleInit();
    expect(use).toHaveBeenCalledTimes(1);
    expect(apiUse).toHaveBeenCalledTimes(1);
  });

  it('считает апдейты по типу', async () => {
    const { bot, use } = makeBot();
    const inc = jest.spyOn(metrics.updates.total, 'inc');
    new BotTelemetryService(bot).instrumentUpdates();
    const middleware = use.mock.calls[0][0];
    const next = jest.fn().mockResolvedValue(undefined);

    await middleware({ update: { message: {} } }, next);
    expect(inc).toHaveBeenCalledWith({ type: 'message' });
    expect(next).toHaveBeenCalled();
  });

  it('считает ошибки обработки и пробрасывает их', async () => {
    const { bot, use } = makeBot();
    const inc = jest.spyOn(metrics.updates.errors, 'inc');
    new BotTelemetryService(bot).instrumentUpdates();
    const middleware = use.mock.calls[0][0];
    const next = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(middleware({ update: { message: {} } }, next)).rejects.toThrow('boom');
    expect(inc).toHaveBeenCalledWith({ type: 'message' });
  });

  it('считает успешные и неуспешные вызовы Bot API', async () => {
    const { bot, apiUse } = makeBot();
    const inc = jest.spyOn(metrics.telegramApi.requests, 'inc');
    const observe = jest.spyOn(metrics.telegramApi.duration, 'observe');
    new BotTelemetryService(bot).instrumentApiCalls();
    const transformer = apiUse.mock.calls[0][0];

    const prevOk = jest.fn().mockResolvedValue('ok');
    await expect(transformer(prevOk, 'sendMessage', { chat_id: 1 })).resolves.toBe('ok');
    expect(inc).toHaveBeenCalledWith({ method: 'sendMessage', result: 'ok' });
    expect(observe).toHaveBeenCalled();

    const prevFail = jest.fn().mockRejectedValue(new Error('nope'));
    await expect(transformer(prevFail, 'getMe', {})).rejects.toThrow('nope');
    expect(inc).toHaveBeenCalledWith({ method: 'getMe', result: 'error' });
  });
});
