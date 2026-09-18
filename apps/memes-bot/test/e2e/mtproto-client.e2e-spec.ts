/**
 * E2E-покрытие MTProto-клиента (apps/memes-bot/src/app/modules/client).
 *
 * Настоящий ClientBaseService поднимается в составе реального AppModule, но
 * пакет `telegram` замокан: TelegramClient — фейк, который лишь запоминает
 * переданные колбэки и умеет отдавать заранее заданные сущности/сообщения.
 * Это позволяет прогнать реальную логику парсера (ad-detection, альбомы,
 * пересылка в канал-обсерваторию) и мост «channel_post → предложка».
 */
import * as bigInt from 'big-integer';

jest.mock('telegram', () => {
  const actual = jest.requireActual('telegram');
  const state = { clients: [] as any[] };

  class FakeTelegramClient {
    public connected = false;
    public session: any;
    public startOptions: any;
    public handlers: any[] = [];

    constructor(session: any) {
      this.session = session;
      state.clients.push(this);
    }

    async connect(): Promise<this> {
      this.connected = true;
      return this;
    }

    async start(options: any): Promise<boolean> {
      this.startOptions = options;
      this.connected = true;
      return true;
    }

    async destroy(): Promise<void> {
      this.connected = false;
    }

    async disconnect(): Promise<void> {
      this.connected = false;
    }

    addEventHandler(handler: any): void {
      this.handlers.push(handler);
    }

    on(): void {
      // no-op
    }

    async getEntity(): Promise<any> {
      return undefined;
    }

    async getMessages(): Promise<any[]> {
      return [];
    }

    async downloadMedia(): Promise<Buffer> {
      return Buffer.alloc(0);
    }
  }

  return { ...actual, TelegramClient: FakeTelegramClient, __mockTelegramState: state };
});

// ВАЖНО: harness импортируется раньше сервисных модулей — так `telegram`
// мокается уже на этапе загрузки AppModule (иначе Jest/TS могут зависнуть
// на компиляции тестового модуля из-за порядка инициализации).
import { E2EHarness, createE2EHarness, findCall, waitFor } from './harness';
import { ClientBaseService } from '../../src/app/modules/client/services/client-base.service';
import { ClientSessionEntity } from '../../src/app/modules/client/entities/client-session.entity';
import { BaseConfigService } from '../../src/app/modules/config/base-config.service';
import { ObservatoryPostEntity } from '../../src/app/modules/observatory/entities/observatory-post.entity';

const mockedTelegram = jest.requireMock('telegram') as any;
const Api = mockedTelegram.Api;
const telegramState = mockedTelegram.__mockTelegramState as {
  clients: any[];
};

const OWNER_ID = Number(process.env.BOT_OWNER_ID);
const EXTERNAL_CHANNEL = -1009999999999;

/** Отдаёт управление циклу событий (микрозадачи + одна макро-итерация). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Прокручивает микрозадачи, не завися от таймеров (для fake timers). */
const flushMicro = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

/** Валидная сессия StringSession: dcId=2, адрес 1.1.1.1, порт 443. */
function validSessionString(addressStr = '1.1.1.1', dcId = 2): string {
  const address = Buffer.from(addressStr);
  const addressLength = Buffer.alloc(2);
  addressLength.writeInt16BE(address.length, 0);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443, 0);
  return (
    '1' +
    Buffer.concat([Buffer.from([dcId]), addressLength, address, port, Buffer.alloc(256, 1)]).toString(
      'base64'
    )
  );
}

function lastClient(): any {
  return telegramState.clients[telegramState.clients.length - 1];
}

describe('E2E: MTProto-клиент и парсер обсерватории', () => {
  let h: E2EHarness;

  beforeEach(async () => {
    h = await createE2EHarness({ realClientBaseService: true });
    await h.resetDb();
    telegramState.clients.length = 0;
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (h) {
      // Чистим БД до следующего boot'а: иначе сохранённая сессия/активный
      // observer будут подняты настоящим ClientBaseService ещё до resetDb().
      await h.resetDb();
      await h.close();
    }
  });

  describe('мост channel_post из канала-обсерватории в предложку', () => {
    it('копирует фото из observer-канала в user-request канал и пишет ObservatoryPost', async () => {
      const config = h.moduleRef.get(BaseConfigService);
      const observerChannel = config.observerChannel;
      const userRequestChannel = config.userRequestMemeChannel;

      await h.sendUpdate({
        update_id: 9001,
        channel_post: {
          message_id: 501,
          date: Math.floor(Date.now() / 1000),
          chat: { id: observerChannel, type: 'channel', title: 'Observer' },
          sender_chat: { id: observerChannel, type: 'channel', title: 'Observer' },
          photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 400, height: 400, file_size: 1000 }],
        },
      });

      await waitFor(() => {
        expect(
          findCall(
            h.calls,
            'copyMessage',
            (payload) =>
              payload.chat_id === userRequestChannel && payload.from_chat_id === observerChannel
          )
        ).toBeDefined();
      });

      await waitFor(async () => {
        const rows = await h.dataSource.getRepository(ObservatoryPostEntity).find();
        expect(rows).toHaveLength(1);
        expect(rows[0].requestChannelMessageId).toBeDefined();
      });
    });

    it('игнорирует channel_post из другого канала', async () => {
      await h.sendUpdate({
        update_id: 9002,
        channel_post: {
          message_id: 502,
          date: Math.floor(Date.now() / 1000),
          chat: { id: EXTERNAL_CHANNEL, type: 'channel', title: 'Other' },
          sender_chat: { id: EXTERNAL_CHANNEL, type: 'channel', title: 'Other' },
          photo: [{ file_id: 'f2', file_unique_id: 'u2', width: 400, height: 400, file_size: 1000 }],
        },
      });

      // Даём подписке шанс сработать и убеждаемся, что её не было.
      await flush();
      expect(findCall(h.calls, 'copyMessage')).toBeUndefined();
      expect(await h.dataSource.getRepository(ObservatoryPostEntity).count()).toBe(0);
    });
  });

  describe('авторизация MTProto через Subjects', () => {
    it('запрашивает телефон, пароль и код и возвращает ответы владельца', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: false });

      await (service as any).startChannelObserver();
      const options = lastClient().startOptions;

      h.clearCalls();
      const phone = options.phoneNumber();
      await flush();
      expect(
        findCall(h.calls, 'sendMessage', (p) => p.chat_id === OWNER_ID && !!p.reply_markup)
      ).toBeDefined();
      (service as any).phoneSubject.next('+79990000000');
      await expect(phone).resolves.toBe('+79990000000');

      const password = options.password();
      await flush();
      (service as any).passwordSubject.next('super-secret');
      await expect(password).resolves.toBe('super-secret');

      const code = options.phoneCode();
      await flush();
      (service as any).phoneCodeSubject.next('12345');
      await expect(code).resolves.toBe('12345');
    });
  });

  describe('saveSession / loadSession', () => {
    it('сохраняет и восстанавливает сессию, отражает isActive', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: validSessionString(), isActive: true });

      const session = await (service as any).loadSession();
      expect(session.dcId).toBe(2);
      expect(session.serverAddress).toBe('1.1.1.1');
      await expect(service.lastObserverStatus()).resolves.toBe(true);

      // Сохраняем другую валидную сессию и проверяем, что она записалась и читается.
      const nextSession = validSessionString('2.2.2.2', 3);
      await (service as any).saveSession(nextSession);
      const row = await repo.findOne({ where: { station: 'main' } });
      expect(row?.session).toBe(nextSession);

      const reloaded = await (service as any).loadSession();
      expect(reloaded.dcId).toBe(3);
      expect(reloaded.serverAddress).toBe('2.2.2.2');
    });
  });

  describe('парсер сообщений MTProto', () => {
    async function startedService(): Promise<{ service: ClientBaseService; client: any }> {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: false });
      await (service as any).startChannelObserver();
      return { service, client: lastClient() };
    }

    it('пересылает одиночный не-рекламный пост в канал-обсерваторию', async () => {
      const config = h.moduleRef.get(BaseConfigService);
      const { client } = await startedService();
      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: { forwardTo },
      };

      await client.handlers[0](event);
      // Сам обработчик события не ждёт onMessageEvent, поэтому даём ему дойти
      // до setTimeout, и только потом двигаем таймеры.
      await flushMicro();
      jest.advanceTimersByTime(5000);
      await flushMicro();

      expect(forwardTo).toHaveBeenCalledTimes(1);
      expect(forwardTo.mock.calls[0][0].equals(bigInt(config.observerChannel))).toBe(true);
    });

    it('не пересылает рекламу со ссылкой на другой канал', async () => {
      const { client } = await startedService();
      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      client.getEntity = jest.fn(async (target: any) =>
        typeof target === 'string' ? { id: bigInt(999) } : { id: bigInt(1) }
      );
      const forwardTo = jest.fn();
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: {
          message: 't.me/other',
          entities: [new Api.MessageEntityUrl({ offset: 0, length: 9 })],
          forwardTo,
        },
      };

      await client.handlers[0](event);
      jest.advanceTimersByTime(10000);
      await flushMicro();

      expect(forwardTo).not.toHaveBeenCalled();
    });

    it('пересылает альбом после дебаунса', async () => {
      const config = h.moduleRef.get(BaseConfigService);
      const { client } = await startedService();
      jest.useFakeTimers();
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: { groupedId: { toString: () => '777' }, forwardTo },
      };

      await client.handlers[0](event);
      jest.advanceTimersByTime(800);
      await flushMicro();

      expect(forwardTo).toHaveBeenCalledTimes(1);
      expect(forwardTo.mock.calls[0][0].equals(bigInt(config.observerChannel))).toBe(true);
    });

    it('не пересылает альбом-рекламу', async () => {
      const { client } = await startedService();
      jest.useFakeTimers();
      client.getEntity = jest.fn(async (target: any) =>
        typeof target === 'string' ? { id: bigInt(999) } : { id: bigInt(1) }
      );
      const forwardTo = jest.fn();
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: {
          groupedId: { toString: () => '888' },
          message: 't.me/other',
          entities: [new Api.MessageEntityUrl({ offset: 0, length: 9 })],
          forwardTo,
        },
      };

      await client.handlers[0](event);
      jest.advanceTimersByTime(800);
      await flushMicro();

      expect(forwardTo).not.toHaveBeenCalled();
    });

    it('пропускает посты из собственных каналов', async () => {
      const config = h.moduleRef.get(BaseConfigService);
      const { client } = await startedService();
      jest.useFakeTimers();
      const forwardTo = jest.fn();
      const event = {
        isChannel: true,
        chatId: bigInt(config.memeChanelId),
        message: { forwardTo },
      };

      await client.handlers[0](event);
      jest.advanceTimersByTime(10000);
      await flushMicro();

      expect(forwardTo).not.toHaveBeenCalled();
    });

    it('daily best meme: копирует лучший пост и эмитит контекст', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const config = h.moduleRef.get(BaseConfigService);
      const { client } = await startedService();
      client.getEntity = jest.fn().mockResolvedValue('channel');
      client.getMessages = jest.fn().mockResolvedValue([
        { id: 11, date: Math.floor(Date.now() / 1000), views: 50, photo: {} },
        { id: 12, date: Math.floor(Date.now() / 1000), views: 5, photo: {} },
      ]);

      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(
        h.calls.some(
          (call) =>
            call.method === 'copyMessage' &&
            call.payload.chat_id === config.bestMemeChanelId &&
            call.payload.message_id === 11
        )
      ).toBe(true);
      expect(received).toHaveLength(1);
    });
  });
});
