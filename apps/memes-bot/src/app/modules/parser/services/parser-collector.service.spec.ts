import { Logger } from '@nestjs/common';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ParserCollectorService } from './parser-collector.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const NOW = new Date('2026-09-19T12:00:00Z');

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1008888888888',
  rawChatId: '8888888888',
  username: 'memes_source',
  title: 'Memes',
  category: 'memes',
  status: 'active',
  selectedTotal: 0,
  rejectedTotal: 0,
  ...overrides,
});

const makeObservedRepo = (): any => ({
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeRegistry = (overrides: Record<string, unknown> = {}): any => ({
  repository: {
    findOne: jest.fn().mockResolvedValue(source(overrides)),
    save: jest.fn().mockResolvedValue(undefined),
  },
  listCollectible: jest.fn().mockResolvedValue([]),
  isOwnChannel: jest.fn((chatId: number) => chatId === -1001111111111),
});

const makeGuard = (): any => ({
  run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()),
  pace: jest.fn().mockResolvedValue(undefined),
  isBlocked: jest.fn(() => false),
  blockedUntil: jest.fn(() => null),
  isPeerBroken: jest.fn(() => false),
  hasBudget: jest.fn(() => true),
  remaining: jest.fn(() => 99),
});

const makeParserClient = (client: Record<string, unknown> = {}): any => ({
  client: jest.fn(() => client),
});

const makeDiscovery = (): any => ({ registerCrossLinks: jest.fn().mockResolvedValue(undefined) });

const makeConfig = (): any => ({
  memeChanelId: -1001111111111,
  cringeMemeChannelId: -1002222222222,
  bestMemeChanelId: -1003333333333,
  userRequestMemeChannel: -1004444444444,
});

const makeClock = (): any => ({ now: jest.fn(() => NOW) });

const mediaMessage = (overrides: Record<string, unknown> = {}): any => {
  const photo = new Api.Photo({
    id: bigInt('555000'),
    accessHash: bigInt('1'),
    fileReference: Buffer.from([]),
    date: 1000,
    sizes: [],
    dcId: 2,
  });

  return {
    id: 42,
    date: 1000,
    message: 'caption t.me/linked_channel',
    peerId: new Api.PeerChannel({ channelId: bigInt('8888888888') }),
    photo,
    get video() {
      return undefined;
    },
    ...overrides,
  } as any;
};

const event = (message: any, chatId = bigInt('-1008888888888')): any => ({
  isChannel: true,
  chatId,
  message,
});

describe('ParserCollectorService', () => {
  let service: ParserCollectorService;
  let observedRepo: any;
  let registry: any;
  let discovery: any;
  let parserClient: any;
  let guard: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    observedRepo = makeObservedRepo();
    registry = makeRegistry();
    discovery = makeDiscovery();
    guard = makeGuard();
    parserClient = makeParserClient({
      getMessages: jest.fn().mockResolvedValue([]),
    });
    service = new ParserCollectorService(
      observedRepo,
      registry,
      guard,
      parserClient,
      discovery,
      makeConfig(),
      makeClock()
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('onLiveEvent', () => {
    it('создаёт кандидата для медиа-поста источника и отдаёт кросс-ссылки в discovery', async () => {
      await service.onLiveEvent(event(mediaMessage()));

      expect(observedRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceChatId: '-1008888888888',
          sourceMessageId: 42,
          mediaKind: 'photo',
          mediaUniqueId: '555000',
          fwdFromChatId: null,
        })
      );
      expect(discovery.registerCrossLinks).toHaveBeenCalledWith([
        { username: 'linked_channel', chatId: null, origin: 'link' },
      ]);
    });

    it('не-канал / свой канал / без медиа → ничего', async () => {
      await service.onLiveEvent({ isChannel: false, message: mediaMessage() } as never);
      await service.onLiveEvent(event(mediaMessage(), bigInt('-1001111111111')));
      await service.onLiveEvent(event(mediaMessage({ photo: undefined })));

      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('нет chatId → ничего', async () => {
      await service.onLiveEvent({ isChannel: true, message: mediaMessage() } as never);
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('сохраняет views/reactions при сборе; пост без реакций → 0', async () => {
      registry.repository.findOne
        .mockResolvedValueOnce(source())
        .mockResolvedValueOnce(source());
      await service.onLiveEvent(
        event(mediaMessage({ views: 5000, reactions: { results: [{ count: 12 }] } }))
      );
      await service.onLiveEvent(event(mediaMessage({ id: 43, views: undefined, reactions: undefined })));

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMessageId: 42, views: 5000, reactions: 12 })
      );
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMessageId: 43, reactions: 0 })
      );
    });

    it('источник не из реестра → ничего', async () => {
      registry.repository.findOne.mockResolvedValue(null);
      await service.onLiveEvent(event(mediaMessage()));
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('альбом копится и создаёт одного кандидата с groupIds', async () => {
      parserClient
        .client()
        .getMessages.mockResolvedValue([mediaMessage({ id: 43, groupedId: bigInt('900') })]);
      await service.onLiveEvent(event(mediaMessage({ id: 42, groupedId: bigInt('900') })));
      await service.onLiveEvent(event(mediaMessage({ id: 43, groupedId: bigInt('900') })));
      jest.advanceTimersByTime(1600);
      for (let i = 0; i < 25; i += 1) await Promise.resolve();

      expect(observedRepo.create).toHaveBeenCalledTimes(1);
      expect(observedRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMessageId: 43,
          groupIds: [42, 43],
        })
      );
    });
  });

  describe('sweepAll', () => {
    it('нет клиента → 0', async () => {
      parserClient.client.mockReturnValue(undefined);
      expect(await service.sweepAll()).toBe(0);
    });

    it('собирает одиночные посты и альбомы из истории', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const albumA = mediaMessage({ id: 10, groupedId: bigInt('700') });
      const albumB = mediaMessage({ id: 11, groupedId: bigInt('700') });
      const single = mediaMessage({ id: 12 });
      parserClient.client().getMessages.mockImplementation(
        async (_peer: unknown, params: { ids?: number[] }) => {
          const ids = params?.ids ?? [];
          if (ids.length) return ids.includes(11) ? [albumB] : [];
          return [albumA, albumB, single];
        }
      );

      const collected = await service.sweepAll();

      expect(collected).toBe(2);
      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: '-1008888888888' })
      );
    });

    it('идемпотентность: существующий кандидат не создаётся', async () => {
      observedRepo.findOne.mockResolvedValue({ id: 99 });
      registry.listCollectible.mockResolvedValue([source()]);
      parserClient.client().getMessages.mockResolvedValue([mediaMessage({ id: 12 })]);

      expect(await service.sweepAll()).toBe(0);
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('альбом в sweep: перечитывание не нашло сообщение → пропуск', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const albumA = mediaMessage({ id: 10, groupedId: bigInt('700') });
      const albumB = mediaMessage({ id: 11, groupedId: bigInt('700') });
      parserClient.client().getMessages.mockImplementation(
        async (_peer: unknown, params: { ids?: number[] }) => {
          const ids = params?.ids ?? [];
          if (ids.length) return [];
          return [albumA, albumB];
        }
      );

      expect(await service.sweepAll()).toBe(0);
    });

    it('web-only источник тоже собирается через sweep', async () => {
      registry.listCollectible.mockResolvedValue([source({ status: 'web_only' })]);
      parserClient.client().getMessages.mockResolvedValue([mediaMessage({ id: 12 })]);

      expect(await service.sweepAll()).toBe(1);
    });

    it('ошибка источника пишется в lastError и не роняет свип', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      parserClient.client().getMessages.mockRejectedValue(new Error('network down'));

      const collected = await service.sweepAll();

      expect(collected).toBe(0);
      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: 'network down' })
      );
    });

    it('guard.run вернул undefined → свип пропускает источник', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const guard = makeGuard();
      guard.run.mockResolvedValue(undefined);
      service = new ParserCollectorService(
        observedRepo,
        registry,
        guard,
        parserClient,
        discovery,
        makeConfig(),
        makeClock()
      );

      expect(await service.sweepAll()).toBe(0);
    });

    it('источник без rawChatId и username исключён из выбора (skippedInvalid)', async () => {
      registry.listCollectible.mockResolvedValue([source({ rawChatId: null, username: null })]);
      parserClient.client().getMessages.mockResolvedValue([]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);
      expect(parserClient.client().getMessages).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=0 skippedInvalid=1 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=0'
      );
    });

    it('свой канал не читается как источник (ни одного MTProto-запроса)', async () => {
      registry.listCollectible.mockResolvedValue([
        source({ chatId: '-1001111111111', username: 'own_channel' }),
        source({ chatId: '-1008888888888' }),
      ]);
      parserClient.client().getMessages.mockResolvedValue([mediaMessage({ id: 12 })]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(1);
      expect(parserClient.client().getMessages).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=1 skippedInvalid=1 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=1'
      );
      expect(guard.run).toHaveBeenCalledWith(
        'getHistory',
        expect.any(Function),
        '-1008888888888'
      );
    });

    it('MTProto на паузе (FloodWait) → свип не дёргает Telegram, лог один на дедлайн', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      guard.isBlocked.mockReturnValue(true);
      guard.blockedUntil.mockReturnValue(1_800_000_000_000);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);
      expect(await service.sweepAll()).toBe(0);

      expect(guard.run).not.toHaveBeenCalled();
      expect(parserClient.client().getMessages).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('MTProto на паузе');
    });

    it('мёртвый пир исключён из выбора (слот живому) и посчитан в skippedBroken', async () => {
      registry.listCollectible.mockResolvedValue([
        source({ chatId: '-1008888888888' }),
        source({ id: 2, chatId: '-1008888888899', rawChatId: '8888888899', username: 'dead' }),
      ]);
      guard.isPeerBroken.mockImplementation(
        (chatId: string | number) => String(chatId) === '-1008888888899'
      );
      parserClient.client().getMessages.mockResolvedValue([mediaMessage({ id: 12 })]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(1);

      const calledPeers = (guard.run as jest.Mock).mock.calls.map(([, , entity]) => String(entity));
      expect(calledPeers).toEqual(['-1008888888888']);
      expect(parserClient.client().getMessages).toHaveBeenCalledTimes(1);
      // Мёртвому пиру lastSweepAt не двигаем — он не участвовал в выборе.
      expect(registry.repository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ chatId: '-1008888888899' })
      );
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=1 skippedInvalid=0 skippedInterval=0 skippedBroken=1 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=1'
      );
      for (const [line] of logSpy.mock.calls) expect(String(line)).not.toContain('8888888899');
    });

    it('мёртвый пир освобождает слот порции живому источнику', async () => {
      // 5 due active, из них 2 мёртвые: в порцию 5+5 должны попасть 5 живых active.
      registry.listCollectible.mockResolvedValue(
        Array.from({ length: 7 }, (_, index) =>
          source({ id: index + 1, chatId: `-100${1000 + index}`, status: 'active', lastSweepAt: null })
        )
      );
      guard.isPeerBroken.mockImplementation(
        (chatId: string | number) => ['-1001000', '-1001001'].includes(String(chatId))
      );
      parserClient.client().getMessages.mockResolvedValue([]);

      await service.sweepAll();

      const calledPeers = (guard.run as jest.Mock).mock.calls.map(([, , entity]) => String(entity));
      expect(calledPeers).toEqual(['-1001002', '-1001003', '-1001004', '-1001005', '-1001006']);
    });


    it('источник без username читается по marked id', async () => {
      registry.listCollectible.mockResolvedValue([source({ username: null })]);
      parserClient.client().getMessages.mockResolvedValue([mediaMessage({ id: 12 })]);

      expect(await service.sweepAll()).toBe(1);
      const peer = parserClient.client().getMessages.mock.calls[0][0];
      expect(String(peer)).toBe('-1008888888888');
    });

    it('альбом: перечитывание вернуло undefined → continue', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const albumA = mediaMessage({ id: 10, groupedId: bigInt('700') });
      parserClient
        .client()
        .getMessages.mockImplementation(async (_p: unknown, params: { ids?: number[] }) =>
          params?.ids?.length ? [] : [albumA]
        );

      expect(await service.sweepAll()).toBe(0);
    });

    it('реакция без count трактуется как 0', async () => {
      await service.onLiveEvent(event(mediaMessage({ reactions: { results: [{ count: undefined }] } })));

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMessageId: 42, reactions: 0 })
      );
    });

    it('альбом без peerId берёт chatId как rawChatId', async () => {
      parserClient.client().getMessages.mockResolvedValue([mediaMessage({ id: 42, groupedId: bigInt('950') })]);
      await service.onLiveEvent(event(mediaMessage({ id: 42, groupedId: bigInt('950'), peerId: undefined })));
      jest.advanceTimersByTime(1600);
      for (let i = 0; i < 25; i += 1) await Promise.resolve();

      expect(observedRepo.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('sweepAll: ротация и бюджет (TGB-125)', () => {
    const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

    it('ротация: active первыми, затем lastSweepAt ASC (null первыми), интервалы статусов, квота тира', async () => {
      registry.listCollectible.mockResolvedValue([
        source({ id: 1, chatId: '-1001', status: 'web_only', lastSweepAt: hoursAgo(30) }),
        source({ id: 2, chatId: '-1002', status: 'active', lastSweepAt: hoursAgo(5) }),
        source({ id: 3, chatId: '-1003', status: 'active', lastSweepAt: null }),
        source({ id: 4, chatId: '-1004', status: 'web_only', lastSweepAt: hoursAgo(1) }),
        source({ id: 5, chatId: '-1005', status: 'active', lastSweepAt: hoursAgo(1) }),
        source({ id: 6, chatId: '-1006', status: 'active', lastSweepAt: null }),
        source({ id: 7, chatId: '-1007', status: 'web_only', lastSweepAt: null }),
        source({ id: 8, chatId: '-1008', status: 'active', lastSweepAt: hoursAgo(10) }),
      ]);
      let budget = 6;
      guard.hasBudget.mockImplementation(() => budget > 0);
      guard.run.mockImplementation(async (_op: string, fn: () => Promise<unknown>) => {
        budget -= 1;
        return fn();
      });
      parserClient.client().getMessages.mockResolvedValue([]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);

      const calls = (guard.run as jest.Mock).mock.calls.map(([op, , entity]) => `${op}:${entity}`);
      expect(calls).toEqual([
        'getHistory:-1003',
        'getHistory:-1006',
        'getHistory:-1008',
        'getHistory:-1002',
        'getHistory:-1007',
        'getHistory:-1001',
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=6 skippedInvalid=0 skippedInterval=2 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=0'
      );
    });

    it('895 источников → 5 active + 5 web_only history-вызовов за прогон', async () => {
      registry.listCollectible.mockResolvedValue(
        Array.from({ length: 895 }, (_, index) =>
          source({
            id: index + 1,
            chatId: `-100${String(index + 1000).padStart(6, '0')}`,
            rawChatId: String(index + 1000),
            username: `chan_${index + 1}`,
            status: index < 78 ? 'active' : 'web_only',
          })
        )
      );
      parserClient.client().getMessages.mockResolvedValue([]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);

      const historyCalls = (guard.run as jest.Mock).mock.calls.filter(([op]) => op === 'getHistory');
      expect(historyCalls).toHaveLength(10);
      expect(parserClient.client().getMessages).toHaveBeenCalledTimes(10);
      expect(guard.pace).toHaveBeenCalledWith(4000);
      // Квота тира: первые 5 — active (ids 1..5), следующие 5 — web_only (ids 79..83).
      const ids = historyCalls.map(([, , entity]) => String(entity));
      const chatIdAt = (index: number): string => `-100${String(index + 1000).padStart(6, '0')}`;
      expect(ids).toEqual([
        ...Array.from({ length: 5 }, (_, i) => chatIdAt(i)),
        ...Array.from({ length: 5 }, (_, i) => chatIdAt(78 + i)),
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=10 skippedInvalid=0 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=0'
      );
    });

    it('тир короче квоты → свободные слоты забирает другой тир, общий кап 10', async () => {
      // Всего 2 due active и 20 due web_only: 2 + 8, порядок — active первыми.
      registry.listCollectible.mockResolvedValue([
        source({ id: 1, chatId: '-1001', status: 'active', lastSweepAt: null }),
        source({ id: 2, chatId: '-1002', status: 'active', lastSweepAt: null }),
        ...Array.from({ length: 20 }, (_, index) =>
          source({
            id: 100 + index,
            chatId: `-101${index}`,
            status: 'web_only',
            lastSweepAt: hoursAgo(25),
          })
        ),
      ]);
      parserClient.client().getMessages.mockResolvedValue([]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.sweepAll();

      const calls = (guard.run as jest.Mock).mock.calls.map(([op, , entity]) => `${op}:${entity}`);
      expect(calls).toHaveLength(10);
      // active первыми (их меньше квоты), остальные 8 — web_only по LRU (id ASC).
      expect(calls.slice(0, 2)).toEqual(['getHistory:-1001', 'getHistory:-1002']);
      expect(calls.slice(2)).toEqual(
        Array.from({ length: 8 }, (_, index) => `getHistory:-101${index}`)
      );
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=10 skippedInvalid=0 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=0'
      );
    });

    it('бюджет history пуст → останавливает порцию и считает skippedBudget', async () => {
      registry.listCollectible.mockResolvedValue(
        Array.from({ length: 8 }, (_, index) =>
          source({ id: index + 1, chatId: `-100${index + 1}`, status: 'active' })
        )
      );
      let budget = 2;
      guard.hasBudget.mockImplementation(() => budget > 0);
      guard.run.mockImplementation(async (_op: string, fn: () => Promise<unknown>) => {
        budget -= 1;
        return fn();
      });
      parserClient.client().getMessages.mockResolvedValue([]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);

      expect(guard.run).toHaveBeenCalledTimes(2);
      expect(parserClient.client().getMessages).toHaveBeenCalledTimes(2);
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=8 skippedInvalid=0 skippedInterval=0 skippedBroken=0 skippedBudget=6 skippedBlocked=0 albumsDeferred=0 collected=0'
      );
    });

    it('пустая история двигает lastSweepAt: ротация не залипает на голове', async () => {
      const src = source();
      registry.listCollectible.mockResolvedValue([src]);
      parserClient.client().getMessages.mockResolvedValue([]);

      await service.sweepAll();

      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastSweepAt: NOW })
      );
    });

    it('вызова не было (guard вернул undefined) → lastSweepAt не двигается', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      guard.run.mockResolvedValue(undefined);

      expect(await service.sweepAll()).toBe(0);
      expect(registry.repository.save).not.toHaveBeenCalled();
    });

    it('окно чтения: первый свип — 26 ч, дальше от lastSweepAt − 1 ч', async () => {
      registry.listCollectible.mockResolvedValue([
        source({ id: 1, chatId: '-1001', lastSweepAt: null }),
        source({ id: 2, chatId: '-1002', lastSweepAt: hoursAgo(6 * 24) }),
      ]);
      parserClient.client().getMessages.mockResolvedValue([]);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.sweepAll();

      const dateAt = (index: number): number =>
        (parserClient.client().getMessages.mock.calls[index][1] as { offsetDate: number })
          .offsetDate;
      const nowSec = Math.floor(NOW.getTime() / 1000);
      expect(dateAt(0)).toBe(Math.floor((NOW.getTime() - 26 * 3_600_000) / 1000));
      expect(dateAt(1)).toBe(Math.floor((NOW.getTime() - (6 * 24 + 1) * 3_600_000) / 1000));
      expect(nowSec).toBeGreaterThan(dateAt(1));
    });

    it('окно чтения не глубже 7 дней (MAX_SWEEP_LOOKBACK_MS)', async () => {
      registry.listCollectible.mockResolvedValue([
        source({ id: 1, chatId: '-1001', lastSweepAt: hoursAgo(30 * 24) }),
      ]);
      parserClient.client().getMessages.mockResolvedValue([]);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.sweepAll();

      const offsetDate = (parserClient.client().getMessages.mock.calls[0][1] as {
        offsetDate: number;
      }).offsetDate;
      expect(offsetDate).toBe(Math.floor((NOW.getTime() - 7 * 24 * 3_600_000) / 1000));
    });

    it('альбом отложен бюджетом → albumsDeferred, кандидат не теряется молча', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const albumA = mediaMessage({ id: 10, groupedId: bigInt('700') });
      const albumB = mediaMessage({ id: 11, groupedId: bigInt('700') });
      guard.run.mockImplementation(
        async (op: string, fn: () => Promise<unknown>) =>
          op === 'getMessages:ids' ? undefined : fn()
      );
      parserClient.client().getMessages.mockResolvedValue([albumA, albumB]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);

      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=1 skippedInvalid=0 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=1 collected=0'
      );
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('альбом перечитан, но сообщения нет (called=true) → не deferred', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const albumA = mediaMessage({ id: 10, groupedId: bigInt('700') });
      parserClient
        .client()
        .getMessages.mockImplementation(async (_p: unknown, params: { ids?: number[] }) =>
          params?.ids?.length ? [] : [albumA]
        );
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.sweepAll();

      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=1 skippedInvalid=0 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=0 albumsDeferred=0 collected=0'
      );
    });

    it('упор в лимит 50 → lastSweepAt = дата самого старого поста (дочитывание продолжается)', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      const oldest = new Date('2026-09-16T09:00:00Z');
      const messages = Array.from({ length: 50 }, (_, index) =>
        mediaMessage({
          id: 100 + index,
          date: Math.floor((oldest.getTime() + index * 3_600_000) / 1000),
          photo: undefined, // без медиа: интересует только курсор
        })
      );
      parserClient.client().getMessages.mockResolvedValue(messages);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.sweepAll();

      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastSweepAt: oldest })
      );
    });

    it('неполная выдача → lastSweepAt = now', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      parserClient.client().getMessages.mockResolvedValue([
        mediaMessage({ id: 10, date: Math.floor(NOW.getTime() / 1000) - 60 }),
      ]);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.sweepAll();

      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastSweepAt: NOW })
      );
    });

    it('history упал, но вызов был (called=true) → lastSweepAt = now, источник не застревает в LRU', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      guard.run.mockImplementation(async (_op: string, fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch {
          return undefined; // guard глотает не-entity ошибку и возвращает undefined
        }
      });
      parserClient.client().getMessages.mockRejectedValue(new Error('CHANNEL_PRIVATE'));
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      expect(await service.sweepAll()).toBe(0);

      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastSweepAt: NOW })
      );
      // Ошибка — не повод писать lastError в свипе: вызова не было в markSourceError.
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('MTProto на паузе посреди порции: остаток не считается бюджетным срезом', async () => {
      registry.listCollectible.mockResolvedValue([
        source({ id: 1, chatId: '-1001', status: 'active' }),
        source({ id: 2, chatId: '-1002', status: 'active' }),
      ]);
      guard.isBlocked.mockReturnValueOnce(false).mockReturnValue(true);
      parserClient.client().getMessages.mockResolvedValue([]);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.sweepAll();

      expect(guard.run).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        'Parser sweep: selected=2 skippedInvalid=0 skippedInterval=0 skippedBroken=0 skippedBudget=0 skippedBlocked=1 albumsDeferred=0 collected=0'
      );
    });
  });

  describe('граничные ветки flushAlbum', () => {
    it('сообщение не найдено → пропуск', async () => {
      parserClient.client().getMessages.mockResolvedValue([]);
      await (service as never as { flushAlbum: (...args: unknown[]) => Promise<unknown> }).flushAlbum({
        ids: [1],
        rawChatId: '8888888888',
        kind: 'photo',
      });
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('свой канал в flushAlbum → пропуск', async () => {
      await (service as never as { flushAlbum: (...args: unknown[]) => Promise<unknown> }).flushAlbum({
        ids: [1],
        rawChatId: '1111111111',
        kind: 'photo',
      });
      expect(observedRepo.create).not.toHaveBeenCalled();
    });

    it('fetchMessage: null в списке → undefined', async () => {
      parserClient.client().getMessages.mockResolvedValue([null]);
      const result = await (
        service as never as { fetchMessage: (id: unknown, msg: number) => Promise<unknown> }
      ).fetchMessage(bigInt('1'), 5);
      expect(result).toBeUndefined();
    });

    it('markSourceError: объект без message', async () => {
      registry.listCollectible.mockResolvedValue([source()]);
      parserClient.client().getMessages.mockRejectedValue({ code: 42 });
      expect(await service.sweepAll()).toBe(0);
      expect(registry.repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: '[object Object]' })
      );
    });
  });
});
