/**
 * E2E-покрытие MTProto-клиента (apps/memes-bot/src/app/modules/client).
 *
 * Настоящий ClientBaseService поднимается в составе реального AppModule, но
 * пакет `telegram` замокан: TelegramClient — фейк, который лишь запоминает
 * переданные колбэки и умеет отдавать заранее заданные сущности/сообщения.
 * Это позволяет прогнать реальную логику парсера (ad-detection, альбомы,
 * пересылку постов боту в личку) и мост «парсер → предложка».
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
import { E2EHarness, createE2EHarness, findCall, privateMessageUpdate, waitFor } from './harness';
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
const PARSER_ID = Number(process.env.PARSER_USER_ID);
const EXTERNAL_CHANNEL = -1009999999999;

/** Update форварда парсера боту в личку: фото с (опциональным) источником. */
function privateParserPhotoUpdate(options: {
  messageId: number;
  updateId: number;
  forwardOrigin?: Record<string, any>;
}): Record<string, any> {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: PARSER_ID, type: 'private' },
      from: { id: PARSER_ID, is_bot: false, first_name: 'Parser', username: 'parser' },
      caption: options.forwardOrigin ? 'исходный текст' : undefined,
      photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 400, height: 400, file_size: 1000 }],
      forward_origin: options.forwardOrigin,
    },
  };
}

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

/** Собирает update callback_query в личке владельца (для waitingClientCommands). */
function callbackQueryUpdate(options: {
  data: string;
  messageId?: number;
  userId?: number;
  updateId?: number;
}): Record<string, any> {
  const userId = options.userId ?? OWNER_ID;
  const messageId = options.messageId ?? 10;
  return {
    update_id: options.updateId ?? 8000,
    callback_query: {
      id: `cb-${options.data}-${messageId}`,
      from: { id: userId, is_bot: false, first_name: 'Owner', username: 'owner' },
      chat_instance: 'test-chat-instance',
      data: options.data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private' },
        from: { id: 42, is_bot: true, first_name: 'TestBot' },
        text: 'menu',
      },
    },
  };
}

/** Строит Api-документ с заданным mimeType (для hasMediaContent). */
function apiDocument(mimeType: string): any {
  return new Api.Document({
    id: bigInt(1) as any,
    accessHash: bigInt(1) as any,
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType,
    size: bigInt(1) as any,
    dcId: 1,
    attributes: [],
  } as any);
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
      // Даём подписке UserPostManagementService на bestMemesDaily$ завершить
      // фоновый SELECT, иначе запрос дойдёт до уже закрытого соединения.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Чистим БД до следующего boot'а: иначе сохранённая сессия/активный
      // observer будут подняты настоящим ClientBaseService ещё до resetDb().
      await h.resetDb();
      await h.close();
    }
  });

  describe('парсер в личке → предложка', () => {
    it('копирует фото от парсера в предложку и пишет ObservatoryPost', async () => {
      const config = h.moduleRef.get(BaseConfigService);
      const userRequestChannel = config.userRequestMemeChannel;

      await h.sendUpdate(privateParserPhotoUpdate({ messageId: 501, updateId: 9001 }));

      await waitFor(() => {
        expect(
          findCall(
            h.calls,
            'copyMessage',
            (payload) =>
              payload.chat_id === userRequestChannel && payload.from_chat_id === PARSER_ID
          )
        ).toBeDefined();
      });

      await waitFor(async () => {
        const rows = await h.dataSource.getRepository(ObservatoryPostEntity).find();
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].requestChannelMessageId)).toBeGreaterThan(0);
        expect(rows[0].isApproved).toBeNull();
        expect(rows[0].publishedMessageId).toBeNull();
      });
    });

    it('переносит источник из forward_origin в служебную подпись и в ObservatoryPost', async () => {
      const config = h.moduleRef.get(BaseConfigService);
      const userRequestChannel = config.userRequestMemeChannel;

      await h.sendUpdate(
        privateParserPhotoUpdate({
          messageId: 601,
          updateId: 9003,
          forwardOrigin: {
            type: 'channel',
            date: Math.floor(Date.now() / 1000),
            message_id: 501,
            chat: {
              id: -1001234567890,
              type: 'channel',
              title: 'Source',
              username: 'source',
            },
          },
        })
      );

      await waitFor(() => {
        expect(
          findCall(
            h.calls,
            'copyMessage',
            (payload) => payload.chat_id === userRequestChannel
          )
        ).toBeDefined();
      });

      const copy = findCall(
        h.calls,
        'copyMessage',
        (payload) => payload.chat_id === userRequestChannel
      );
      expect(copy!.payload.caption).toBe(
        '🔎 Источник: <a href="https://t.me/source/501">Source</a>'
      );
      expect(copy!.payload.parse_mode).toBe('HTML');

      await waitFor(async () => {
        const rows = await h.dataSource.getRepository(ObservatoryPostEntity).find();
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].sourceMessageId)).toBe(501);
        expect(rows[0].sourceUsername).toBe('source');
        expect(rows[0].sourceUrl).toBe('https://t.me/source/501');
        expect(rows[0].originalCaption).toBe('исходный текст');
      });
    });

    it('channel_post из канала-коллектора больше не обрабатывается', async () => {
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

      await flush();
      expect(findCall(h.calls, 'copyMessage')).toBeUndefined();
      expect(await h.dataSource.getRepository(ObservatoryPostEntity).count()).toBe(0);
    });

    it('игнорирует фото в личке не от парсера', async () => {
      const strangerId = 818181;
      await h.sendUpdate({
        update_id: 9004,
        message: {
          message_id: 503,
          date: Math.floor(Date.now() / 1000),
          chat: { id: strangerId, type: 'private' },
          from: { id: strangerId, is_bot: false, first_name: 'Stranger', username: 'stranger' },
          photo: [{ file_id: 'f9', file_unique_id: 'u9', width: 100, height: 100, file_size: 1 }],
        },
      });

      await flush();
      expect(findCall(h.calls, 'copyMessage', (p) => p.from_chat_id === strangerId)).toBeUndefined();
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

    it('пересылает одиночный не-рекламный медиапост боту', async () => {
      const { client } = await startedService();
      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: { photo: [{ file_id: 'p' }], forwardTo },
      };

      await client.handlers[0](event);
      // Сам обработчик события не ждёт onMessageEvent, поэтому даём ему дойти
      // до setTimeout, и только потом двигаем таймеры.
      await flushMicro();
      jest.advanceTimersByTime(5000);
      await flushMicro();

      expect(forwardTo).toHaveBeenCalledTimes(1);
      expect(forwardTo).toHaveBeenCalledWith('@test_bot');
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
          photo: [{ file_id: 'p' }],
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

    it('пересылает пост со ссылкой на собственный канал', async () => {
      const { client } = await startedService();
      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      client.getEntity = jest.fn().mockResolvedValue({ id: bigInt(1) });
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: {
          photo: [{ file_id: 'p' }],
          message: 't.me/own',
          entities: [new Api.MessageEntityUrl({ offset: 0, length: 7 })],
          forwardTo,
        },
      };

      await client.handlers[0](event);
      await flushMicro();
      jest.advanceTimersByTime(10000);
      await flushMicro();

      expect(forwardTo).toHaveBeenCalledTimes(1);
      expect(forwardTo).toHaveBeenCalledWith('@test_bot');
    });

    it('пересылает альбом после дебаунса', async () => {
      const { client } = await startedService();
      jest.useFakeTimers();
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: { groupedId: { toString: () => '777' }, photo: [{ file_id: 'p' }], forwardTo },
      };

      await client.handlers[0](event);
      jest.advanceTimersByTime(800);
      await flushMicro();

      expect(forwardTo).toHaveBeenCalledTimes(1);
      expect(forwardTo).toHaveBeenCalledWith('@test_bot');
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
          photo: [{ file_id: 'p' }],
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

  describe('жизненный цикл observer', () => {
    it('toggleChannelObserver останавливает подключённый клиент и снимает флаг', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: true });
      const destroy = jest.fn().mockResolvedValue(undefined);
      (service as any).telegramClient = { connected: true, destroy };

      await service.toggleChannelObserver();

      expect(destroy).toHaveBeenCalledTimes(1);
      await expect(service.lastObserverStatus()).resolves.toBe(false);
    });

    it('toggleChannelObserver не трогает отключённый клиент', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: true });
      const destroy = jest.fn();
      (service as any).telegramClient = { connected: false, destroy };

      await service.toggleChannelObserver();

      expect(destroy).not.toHaveBeenCalled();
      await expect(service.lastObserverStatus()).resolves.toBe(false);
    });

    it('toggleChannelObserver запускает станцию, когда обсерватория выключена', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: false });
      const startSpy = jest
        .spyOn(service as any, 'startChannelObserver')
        .mockResolvedValue(undefined);

      await service.toggleChannelObserver();

      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('checkAutoRunObserver поднимает станцию при активной сессии', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: true });
      const startSpy = jest
        .spyOn(service as any, 'startChannelObserver')
        .mockResolvedValue(undefined);

      await (service as any).checkAutoRunObserver();

      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('onModuleInit не поднимает станцию при isActive=false', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: false });
      const startSpy = jest
        .spyOn(service as any, 'startChannelObserver')
        .mockResolvedValue(undefined);

      await service.onModuleInit();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('startChannelObserver без записи в БД использует пустую сессию', async () => {
      const service = h.moduleRef.get(ClientBaseService);

      await (service as any).startChannelObserver();
      await flush();

      expect(lastClient().session.save()).toBe('');
    });

    it('startChannelObserver восстанавливает сохранённую сессию', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      const session = validSessionString();
      await repo.save({ station: 'main', session, isActive: false });

      await (service as any).startChannelObserver();
      await flush();

      expect(lastClient().session.dcId).toBe(2);
      expect(lastClient().session.serverAddress).toBe('1.1.1.1');
      const row = await repo.findOne({ where: { station: 'main' } });
      expect(row?.isActive).toBe(true);
      await expect(service.lastObserverStatus()).resolves.toBe(true);
    });

    it('onError из start не роняет приложение', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      await (service as any).startChannelObserver();
      await flush();

      expect(() => lastClient().startOptions.onError(new Error('boom'))).not.toThrow();
    });

    it('loadSession возвращает пустую сессию без записи, lastObserverStatus — false', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const session = await (service as any).loadSession();
      expect(session.save()).toBe('');
      await expect(service.lastObserverStatus()).resolves.toBe(false);
    });

    it('changeObserverState пишет флаг isActive', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: false });

      await (service as any).changeObserverState(true);

      await expect(service.lastObserverStatus()).resolves.toBe(true);
    });
  });

  describe('авторизация — callback-команды и конверсации', () => {
    it('registerConversations и waitingClientCommands регистрируют беседы и callbacks', () => {
      const service = h.moduleRef.get(ClientBaseService);
      const callbackSpy = jest.spyOn(h.bot, 'callbackQuery');
      const useSpy = jest.spyOn(h.bot, 'use');

      (service as any).registerConversations();
      (service as any).waitingClientCommands();

      const triggers = callbackSpy.mock.calls.map((call) => call[0]);
      expect(triggers).toEqual(
        expect.arrayContaining(['fill_client_phone', 'fill_client_password', 'fill_client_code'])
      );
      expect(useSpy).toHaveBeenCalled();
    });

    it('callback fill_client_phone заходит в беседу и принимает номер', async () => {
      const service = h.moduleRef.get(ClientBaseService);

      await h.sendUpdate(
        callbackQueryUpdate({ data: 'fill_client_phone', messageId: 60, updateId: 8101 })
      );
      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => String(p.text).includes('Введи номер телефона'))
        ).toBeDefined()
      );

      const nextSpy = jest.spyOn((service as any).phoneSubject, 'next');
      await h.sendUpdate(
        privateMessageUpdate({
          userId: OWNER_ID,
          text: '+79990001122',
          messageId: 61,
          updateId: 8102,
        })
      );
      await waitFor(() => expect(nextSpy).toHaveBeenCalledWith('+79990001122'));
    });

    it('callback fill_client_password заходит в беседу и принимает пароль', async () => {
      const service = h.moduleRef.get(ClientBaseService);

      await h.sendUpdate(
        callbackQueryUpdate({ data: 'fill_client_password', messageId: 62, updateId: 8103 })
      );
      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => String(p.text).includes('Введи пароль'))
        ).toBeDefined()
      );

      const nextSpy = jest.spyOn((service as any).passwordSubject, 'next');
      await h.sendUpdate(
        privateMessageUpdate({
          userId: OWNER_ID,
          text: 'super-secret',
          messageId: 63,
          updateId: 8104,
        })
      );
      await waitFor(() => expect(nextSpy).toHaveBeenCalledWith('super-secret'));
    });

    it('callback fill_client_code заходит в беседу и принимает код', async () => {
      const service = h.moduleRef.get(ClientBaseService);

      await h.sendUpdate(
        callbackQueryUpdate({ data: 'fill_client_code', messageId: 64, updateId: 8105 })
      );
      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => String(p.text).includes('Введи код подтверждения'))
        ).toBeDefined()
      );

      const nextSpy = jest.spyOn((service as any).phoneCodeSubject, 'next');
      await h.sendUpdate(
        privateMessageUpdate({
          userId: OWNER_ID,
          text: '12345',
          messageId: 65,
          updateId: 8106,
        })
      );
      await waitFor(() => expect(nextSpy).toHaveBeenCalledWith('12345'));
    });

    it('конверсации игнорируют ответ без текста', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const cases: Array<[string, string]> = [
        ['phoneConversation', 'phoneSubject'],
        ['passwordConversation', 'passwordSubject'],
        ['phoneCodeConversation', 'phoneCodeSubject'],
      ];

      for (const [method, subject] of cases) {
        const nextSpy = jest.spyOn((service as any)[subject], 'next');
        for (const value of [undefined, {}, { message: {} }]) {
          const conversation = { wait: jest.fn().mockResolvedValue(value) };
          await (service as any)[method](conversation, { reply: jest.fn() });
        }
        expect(nextSpy).not.toHaveBeenCalled();
      }
    });
  });

  describe('детекция рекламы и разбор ссылок', () => {
    it('isPostWithLinks покрывает caption и типы сущностей', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const fn = (service as any).isPostWithLinks.bind(service);

      await expect(fn({ message: {} })).resolves.toBe(false);
      await expect(fn({})).resolves.toBe(false);
      await expect(fn()).resolves.toBe(false);
      await expect(
        fn({
          message: { message: 'x', entities: [new Api.MessageEntityUrl({ offset: 0, length: 1 })] },
        })
      ).resolves.toBe(true);
      await expect(
        fn({
          message: {
            message: 'x',
            entities: [new Api.MessageEntityTextUrl({ offset: 0, length: 1, url: 'https://t.me/y' })],
          },
        })
      ).resolves.toBe(true);
      await expect(fn({ message: { message: 'x', entities: [{}] } })).resolves.toBe(false);
    });

    it('extractUrls покрывает Url и TextUrl', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const fn = (service as any).extractUrls.bind(service);

      await expect(fn({ message: {} })).resolves.toEqual([]);
      await expect(
        fn({
          message: {
            message: 'go https://site.ru now',
            entities: [new Api.MessageEntityUrl({ offset: 3, length: 15 })],
          },
        })
      ).resolves.toEqual(['https://site.ru']);
      await expect(
        fn({
          message: {
            message: 't.me/hidden',
            entities: [
              new Api.MessageEntityTextUrl({ offset: 0, length: 12, url: 'https://t.me/hidden' }),
            ],
          },
        })
      ).resolves.toEqual(['https://t.me/hidden']);
    });

    it('resolveUrl покрывает короткую t.me, полную t.me и внешний URL', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const getEntity = jest.fn().mockResolvedValue({ id: bigInt(5) });
      (service as any).telegramClient = { getEntity };

      await expect((service as any).resolveUrl('t.me/somechannel')).resolves.toEqual({ id: bigInt(5) });
      expect(getEntity).toHaveBeenLastCalledWith('somechannel');

      await (service as any).resolveUrl('https://t.me/channel/123');
      expect(getEntity).toHaveBeenLastCalledWith('channel');

      await expect((service as any).resolveUrl('https://example.com/x')).resolves.toEqual({
        isExternal: true,
        url: 'https://example.com/x',
      });
    });

    it('isSameChannel покрывает внешний URL, id и username', () => {
      const service = h.moduleRef.get(ClientBaseService);
      const fn = (service as any).isSameChannel.bind(service);

      expect(fn({ isExternal: true }, { id: bigInt(1) })).toBe(false);
      expect(fn({ id: bigInt(1) }, { id: bigInt(1) })).toBe(true);
      expect(fn({ id: bigInt(1) }, { id: bigInt(2) })).toBe(false);
      expect(fn({ username: 'Channel' }, { username: 'channel' })).toBe(true);
      expect(fn({ username: 'a' }, { username: 'b' })).toBe(false);
      expect(fn({ id: bigInt(1) }, { username: 'x' })).toBe(false);
      expect(fn({}, {})).toBe(false);
    });

    it('hasMediaContent покрывает все ветви', () => {
      const service = h.moduleRef.get(ClientBaseService);
      const fn = (service as any).hasMediaContent.bind(service);

      expect(fn({ photo: {} })).toBe(true);
      expect(fn({ video: {} })).toBe(true);
      expect(fn({ media: new Api.MessageMediaPhoto({} as any) })).toBe(true);
      expect(
        fn({
          media: new Api.MessageMediaDocument({
            document: apiDocument('video/mp4'),
          } as any),
        })
      ).toBe(true);
      expect(
        fn({
          media: new Api.MessageMediaDocument({
            document: apiDocument('image/png'),
          } as any),
        })
      ).toBe(false);
      expect(fn({ media: new Api.MessageMediaDocument({ document: {} } as any) })).toBe(false);
      expect(fn({ media: {} })).toBe(false);
      expect(fn({})).toBe(false);
    });

    it('isAdPost: чужой канал, свой канал и ошибка резолва', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const urlEvent = () => ({
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: {
          message: 't.me/other',
          entities: [new Api.MessageEntityUrl({ offset: 0, length: 9 })],
        },
      });

      await expect((service as any).isAdPost({ message: { message: 'hi' } })).resolves.toBe(false);

      (service as any).telegramClient = {
        getEntity: jest.fn(async (target: any) =>
          typeof target === 'string' ? { id: bigInt(999) } : { id: bigInt(1) }
        ),
      };
      await expect((service as any).isAdPost(urlEvent())).resolves.toBe(true);

      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue({ id: bigInt(1) }),
      };
      await expect((service as any).isAdPost(urlEvent())).resolves.toBe(false);

      (service as any).telegramClient = {
        getEntity: jest.fn(async (target: any) => {
          if (typeof target === 'string') {
            throw new Error('nope');
          }
          return { id: bigInt(1) };
        }),
      };
      await expect((service as any).isAdPost(urlEvent())).resolves.toBe(true);
    });

    it('isAdPost: защитные ветви для пустого текста и отсутствия URL', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(true);

      await expect((service as any).isAdPost({ message: {} })).resolves.toBe(false);
      await expect((service as any).isAdPost({ message: { message: 'hi' } })).resolves.toBe(false);
    });
  });

  describe('handleAlbum и onMessageEvent — дополнительные ветви', () => {
    async function observerClient(): Promise<{ service: ClientBaseService; client: any }> {
      const service = h.moduleRef.get(ClientBaseService);
      const repo = h.dataSource.getRepository(ClientSessionEntity);
      await repo.save({ station: 'main', session: '', isActive: false });
      await (service as any).startChannelObserver();
      return { service, client: lastClient() };
    }

    it('сбрасывает таймер при повторном сообщении той же группы', async () => {
      const { client } = await observerClient();
      jest.useFakeTimers();
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const first = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: { groupedId: { toString: () => '555' }, photo: [{ file_id: 'p' }], forwardTo },
      };
      const second = {
        isChannel: true,
        chatId: bigInt(EXTERNAL_CHANNEL),
        message: { groupedId: { toString: () => '555' }, photo: [{ file_id: 'p' }], forwardTo },
      };

      await client.handlers[0](first);
      await client.handlers[0](second);
      jest.advanceTimersByTime(800);
      await flushMicro();

      expect(forwardTo).toHaveBeenCalledTimes(1);
    });

    it('игнорирует не-канальные события', async () => {
      const { client } = await observerClient();
      const forwardTo = jest.fn();

      await client.handlers[0]({ isChannel: false, message: { forwardTo } });
      await flush();

      expect(forwardTo).not.toHaveBeenCalled();
    });
  });

  describe('postDailyBestMeme — ветви выбора лучшего', () => {
    const nowSeconds = (): number => Math.floor(Date.now() / 1000);

    function setMessages(service: ClientBaseService, messages: any[]): void {
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue(messages),
      };
    }

    it('пустой канал: ничего не постит и не эмитит', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      setMessages(service, []);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(received).toEqual([]);
      expect(findCall(h.calls, 'copyMessage')).toBeUndefined();
    });

    it('нет сообщений за сутки: ничего не постит', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      setMessages(service, [{ id: 1, date: 1, views: 100, photo: {} }]);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(received).toEqual([]);
    });

    it('нет подходящих сообщений (0 просмотров и без реакций)', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      setMessages(service, [{ id: 2, date: nowSeconds(), views: 0, photo: {} }]);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(received).toEqual([]);
      expect(findCall(h.calls, 'copyMessage')).toBeUndefined();
    });

    it('один пост лучший и по просмотрам, и по реакциям', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const config = h.moduleRef.get(BaseConfigService);
      setMessages(service, [
        {
          id: 11,
          date: nowSeconds(),
          views: 50,
          photo: {},
          reactions: { results: [{ count: 3 }, { count: 4 }] },
        },
        { id: 12, date: nowSeconds(), views: 5, photo: {} },
      ]);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      const call = findCall(
        h.calls,
        'copyMessage',
        (p) => p.chat_id === config.bestMemeChanelId && p.message_id === 11
      );
      expect(call).toBeDefined();
      expect(call!.payload.disable_notification).toBe(false);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ byViewPostMemeId: 11, byLikePostMemeId: 11 });
      expect(received[0].byViewPostBestMemeId).toBeDefined();
    });

    it('разные посты: лучший по просмотрам (silent) и лучший по реакциям', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      setMessages(service, [
        { id: 21, date: nowSeconds(), views: 90, photo: {} },
        {
          id: 22,
          date: nowSeconds(),
          views: 10,
          photo: {},
          reactions: { results: [{ count: 9 }] },
        },
      ]);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      const byViews = findCall(h.calls, 'copyMessage', (p) => p.message_id === 21);
      const byReactions = findCall(h.calls, 'copyMessage', (p) => p.message_id === 22);
      expect(byViews!.payload.disable_notification).toBe(true);
      expect(byReactions!.payload.disable_notification).toBe(false);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ byViewPostMemeId: 21, byLikePostMemeId: 22 });
      expect(received[0].byLikePostBestMemeId).toBeDefined();
    });

    it('только реакции: постит лучший по реакциям', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      setMessages(service, [
        {
          id: 41,
          date: nowSeconds(),
          views: 0,
          photo: {},
          reactions: { results: [{ count: 7 }] },
        },
      ]);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      const call = findCall(h.calls, 'copyMessage', (p) => p.message_id === 41);
      expect(call).toBeDefined();
      expect(call!.payload.disable_notification).toBe(false);
      expect(received[0]).toMatchObject({ byLikePostMemeId: 41 });
      expect(received[0].byLikePostBestMemeId).toBeDefined();
    });

    it('alternateChatId: постит туда и не эмитит событие', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      setMessages(service, [{ id: 31, date: nowSeconds(), views: 5, photo: {} }]);
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme(999);

      expect(
        findCall(h.calls, 'copyMessage', (p) => Number(p.chat_id) === 999 && p.message_id === 31)
      ).toBeDefined();
      expect(received).toEqual([]);
    });

    it('ошибка обращения к каналу: эмитит запасной контекст и пробрасывает', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      (service as any).telegramClient = {
        getEntity: jest.fn().mockRejectedValue(new Error('boom')),
        getMessages: jest.fn(),
      };
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await expect(service.postDailyBestMeme()).rejects.toThrow('boom');
      expect(received).toEqual([{}]);
    });
  });

  describe('copyMessage', () => {
    it('копирует в bestMemeChanelId и уважает silent', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const config = h.moduleRef.get(BaseConfigService);
      const copy = jest
        .spyOn(h.bot.api, 'copyMessage')
        .mockResolvedValue({ message_id: 321 } as any);

      await expect((service as any).copyMessage(7, true)).resolves.toBe(321);
      expect(copy).toHaveBeenCalledWith(
        config.bestMemeChanelId,
        config.memeChanelId,
        7,
        { disable_notification: true }
      );
    });

    it('копирует в alternateChatId', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      const copy = jest
        .spyOn(h.bot.api, 'copyMessage')
        .mockResolvedValue({ message_id: 1 } as any);

      await (service as any).copyMessage(8, false, 555);

      expect(copy.mock.calls[0][0]).toBe(555);
      expect(copy.mock.calls[0][3]).toEqual({ disable_notification: false });
    });

    it('возвращает undefined при ошибке копирования', async () => {
      const service = h.moduleRef.get(ClientBaseService);
      jest.spyOn(h.bot.api, 'copyMessage').mockRejectedValue(new Error('copy failed'));

      await expect((service as any).copyMessage(9, false)).resolves.toBeUndefined();
    });
  });
});
