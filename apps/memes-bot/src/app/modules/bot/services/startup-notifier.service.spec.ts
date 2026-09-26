import { Logger } from '@nestjs/common';
import { APP_VERSION } from '../../../version';
import { StartupNotifierService } from './startup-notifier.service';

describe('StartupNotifierService', () => {
  const ownerId = 424242;

  const makeService = (sendMessage: jest.Mock) => {
    const bot = { api: { sendMessage } } as any;
    const config = { ownerId, tgEnv: 'test' } as any;

    return new StartupNotifierService(bot, config);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('включает версию, окружение и время в текст уведомления', () => {
    const service = makeService(jest.fn());
    const now = new Date('2026-09-18T12:00:00.000Z');

    const text = service.buildStartupMessage(now);

    expect(text).toContain(`Версия: ${APP_VERSION}`);
    expect(text).toContain('Окружение: test');
    expect(text).toContain('Время: 2026-09-18T12:00:00.000Z');
  });

  it('отправляет уведомление владельцу на старте приложения', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = makeService(sendMessage);

    await service.onApplicationBootstrap();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0];
    expect(chatId).toBe(ownerId);
    expect(text).toContain(APP_VERSION);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`версия ${APP_VERSION}`)
    );
  });

  it('не роняет старт приложения, если отправка упала', async () => {
    const sendMessage = jest.fn().mockRejectedValue(new Error('telegram is down'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = makeService(sendMessage);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('telegram is down'));
  });
});
