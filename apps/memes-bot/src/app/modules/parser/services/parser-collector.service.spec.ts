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

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    observedRepo = makeObservedRepo();
    registry = makeRegistry();
    discovery = makeDiscovery();
    parserClient = makeParserClient({
      getMessages: jest.fn().mockResolvedValue([]),
    });
    service = new ParserCollectorService(
      observedRepo,
      registry,
      makeGuard(),
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
  });
});
