import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { SourceCategory, SourceStatus } from '../constants/parser.constants';
import { ParserRegistryService } from './parser-registry.service';

const NOW = new Date('2026-09-19T12:00:00Z');

const makeSourceRepo = (): any => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  count: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeObservedRepo = (): any => ({
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeConfig = (): any => ({
  memeChanelId: -1001111111111,
  cringeMemeChannelId: -1002222222222,
  bestMemeChanelId: -1003333333333,
  userRequestMemeChannel: -1004444444444,
});

const makeGuard = (): any => ({
  run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()),
  pace: jest.fn().mockResolvedValue(undefined),
});

const makeParserClient = (client: unknown = {}): any => ({ client: jest.fn(() => client) });

const makeClock = (): any => ({ now: jest.fn(() => NOW) });

const makeSettingsStub = (): any => ({
  current: { maxSources: 50 },
});

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-100777',
  rawChatId: '777',
  username: 'memes_source',
  title: 'Memes',
  category: SourceCategory.MEMES,
  status: SourceStatus.ACTIVE,
  subscribers: null,
  err: null,
  baseline: null,
  selectedTotal: 0,
  rejectedTotal: 0,
  statsUpdatedAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

describe('ParserRegistryService', () => {
  let service: ParserRegistryService;
  let sourceRepo: any;
  let observedRepo: any;
  let parserClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    sourceRepo = makeSourceRepo();
    observedRepo = makeObservedRepo();
    parserClient = makeParserClient({ getDialogs: jest.fn().mockResolvedValue([]) });
    service = new ParserRegistryService(
      sourceRepo,
      observedRepo,
      makeConfig(),
      makeGuard(),
      parserClient,
      makeSettingsStub(),
      makeClock()
    );
  });

  it('listCollectible берёт active и web_only', async () => {
    await service.listCollectible();
    expect(sourceRepo.find).toHaveBeenCalledWith({
      where: [{ status: SourceStatus.ACTIVE }, { status: SourceStatus.WEB_ONLY }],
    });
  });

  it('listAll/toggleStatus/setCategory работают', async () => {
    sourceRepo.find.mockResolvedValue([source()]);
    sourceRepo.findOne.mockResolvedValue(source());
    await service.listAll();
    expect(sourceRepo.find).toHaveBeenCalledWith({ order: { id: 'ASC' } });

    await service.toggleStatus(1);
    expect(sourceRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: SourceStatus.DISABLED }));

    await service.toggleStatus(1);
    expect(sourceRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: SourceStatus.ACTIVE }));

    await service.setCategory(1, SourceCategory.CRINGE);
    expect(sourceRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ category: SourceCategory.CRINGE }));
  });

  it('toggleStatus: нет источника → null', async () => {
    sourceRepo.findOne.mockResolvedValue(null);
    expect(await service.toggleStatus(99)).toBeNull();
    expect(await service.setCategory(99, SourceCategory.CRINGE)).toBeNull();
  });

  it('importSubscriptions: guard не смог получить диалоги → 0', async () => {
    const guard = makeGuard();
    guard.run.mockResolvedValue(undefined);
    parserClient = makeParserClient({});
    service = new ParserRegistryService(sourceRepo, observedRepo, makeConfig(), guard, parserClient, makeSettingsStub(), makeClock());
    expect(await service.importSubscriptions()).toBe(0);
  });

  it('refreshSourceStats: без rawChatId и username не дёргает MTProto', async () => {
    observedRepo.find.mockResolvedValue([]);
    const invoke = jest.fn();
    const updated = await service.refreshSourceStats(
      source({ rawChatId: null, username: null }),
      { invoke } as never
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(updated?.subscribers).toBeNull();
  });

  it('refreshSourceStats: participants=0 → ERR не пишем', async () => {
    observedRepo.find.mockResolvedValue([]);
    const invoke = jest.fn().mockResolvedValue({ fullChat: { participantsCount: 0 } });
    const updated = await service.refreshSourceStats(source(), { invoke } as never);
    expect(updated?.subscribers).toBeNull();
    expect(updated?.statsUpdatedAt).toEqual(NOW);
  });

  it('isOwnChannel распознаёт свои каналы', () => {
    expect(service.isOwnChannel(-1001111111111)).toBe(true);
    expect(service.isOwnChannel(-1004444444444)).toBe(true);
    expect(service.isOwnChannel(-1008888888888)).toBe(false);
  });

  describe('importSubscriptions', () => {
    it('нет клиента → 0', async () => {
      parserClient.client.mockReturnValue(undefined);
      expect(await service.importSubscriptions()).toBe(0);
    });

    it('импортирует только broadcast-каналы, не свои', async () => {
      const dialog = (broadcast: boolean, id: string, username: string) => ({
        entity: Object.assign(new Api.Channel({ id: bigInt(id), title: 'T', username, photo: undefined, date: 1 }), {
          broadcast,
        }),
      });

      parserClient.client().getDialogs.mockResolvedValue([
        dialog(true, '8888888888', 'channel_one'),
        dialog(false, '9999999999', 'megagroup'),
        dialog(true, '1111111111', 'own_channel'),
      ]);
      sourceRepo.findOne.mockResolvedValue(null);

      const created = await service.importSubscriptions();

      expect(created).toBe(1);
      expect(sourceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-1008888888888',
          username: 'channel_one',
          status: SourceStatus.ACTIVE,
        })
      );
    });

    it('существующие источники не дублируются', async () => {
      parserClient.client().getDialogs.mockResolvedValue([
        {
          entity: Object.assign(
            new Api.Channel({ id: bigInt('8888888888'), title: 'T', username: 'dup', photo: undefined, date: 1 }),
            {
              broadcast: true,
            }
          ),
        },
      ]);
      sourceRepo.findOne.mockResolvedValue(source({ chatId: '-1008888888888' }));

      expect(await service.importSubscriptions()).toBe(0);
      expect(sourceRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('addSource', () => {
    it('создаёт источник и не дублирует', async () => {
      const created = await service.addSource({ chatId: -100555, username: 'new' });
      expect(created).toMatchObject({ chatId: '-100555', status: SourceStatus.ACTIVE });

      sourceRepo.findOne.mockResolvedValueOnce(source({ chatId: '-100555' }));
      const again = await service.addSource({ chatId: -100555 });
      expect(again).toMatchObject({ chatId: '-100555' });
    });

    it('переполненный реестр отклоняет добавление', async () => {
      sourceRepo.count.mockResolvedValue(50);
      const result = await service.addSource({ chatId: -100666 });
      expect(result).toBeNull();
    });
  });

  describe('refreshSourceStats', () => {
    it('обновляет базлайн, подписчики и ERR', async () => {
      observedRepo.find.mockResolvedValue([
        { views: 1000, reactions: 10, metrics: { posShare: 0.9 } },
        { views: 2000, reactions: 20, metrics: { posShare: 0.8 } },
        { views: 3000, reactions: 30, metrics: { posShare: 0.7 } },
        { views: 4000, reactions: 40, metrics: { posShare: 0.6 } },
        { views: 5000, reactions: 50, metrics: { posShare: 0.5 } },
      ]);
      const guard = makeGuard();
      guard.run.mockImplementation(async (_op: string, fn: () => Promise<unknown>) => fn());
      service = new ParserRegistryService(
        sourceRepo,
        observedRepo,
        makeConfig(),
        guard,
        makeParserClient({
          invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 20000 } }),
        }),
        makeSettingsStub(),
        makeClock()
      );

      const updated = await service.refreshSourceStats(source(), {
        invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 20000 } }),
      } as never);

      expect(updated?.baseline).toMatchObject({ vmed: 3000, sampleSize: 5 });
      expect(updated?.subscribers).toBe(20000);
      expect(updated?.err).toBeCloseTo(3000 / 20000);
      expect(updated?.statsUpdatedAt).toEqual(NOW);
    });
  });

  describe('seedBaselineFromHistory', () => {
    const makeClient = (messages: unknown[]) => ({ getMessages: jest.fn().mockResolvedValue(messages) });

    it('нет peer → null', async () => {
      const service = new ParserRegistryService(
        sourceRepo, observedRepo, makeConfig(), makeGuard(), makeParserClient({}), makeSettingsStub(), makeClock()
      );
      expect(
        await service.seedBaselineFromHistory(source({ rawChatId: null, username: null }), { getMessages: jest.fn() } as never)
      ).toBeNull();
    });

    it('guard вернул undefined → null', async () => {
      const guard = makeGuard();
      guard.run.mockResolvedValue(undefined);
      const service = new ParserRegistryService(
        sourceRepo, observedRepo, makeConfig(), guard, makeParserClient({}), makeSettingsStub(), makeClock()
      );
      expect(await service.seedBaselineFromHistory(source(), makeClient([]) as never)).toBeNull();
    });

    it('мало постов с просмотрами → null', async () => {
      const service = new ParserRegistryService(
        sourceRepo, observedRepo, makeConfig(), makeGuard(),
        makeParserClient(makeClient([
          { photo: {}, views: 100, reactions: { results: [] } },
          { photo: {}, views: 200, reactions: { results: [] } },
        ])),
        makeSettingsStub(), makeClock()
      );
      expect(await service.seedBaselineFromHistory(source(), makeClient([]) as never)).toBeNull();
    });

    it('грязные данные: реакции без count/emoticon, results undefined', async () => {
      const dirty = [
        { photo: {}, views: 1000, reactions: {} },
        { photo: {}, views: 2000, reactions: { results: [{}, { count: undefined, reaction: undefined }] } },
        { photo: {}, views: 3000 },
        { photo: {}, views: 4000, reactions: { results: [{ count: 5, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 5000, reactions: { results: [{ count: 6, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 6000, reactions: { results: [{ count: 7, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: null, reactions: { results: [] } },
      ];
      const service = new ParserRegistryService(
        sourceRepo, observedRepo, makeConfig(), makeGuard(),
        makeParserClient(makeClient(dirty)), makeSettingsStub(), makeClock()
      );

      expect(await service.seedBaselineFromHistory(source(), makeClient(dirty) as never)).toMatchObject({
        sampleSize: 6,
      });
    });

    it('успех: считает базлайн и сохраняет в источник', async () => {
      const service = new ParserRegistryService(
        sourceRepo, observedRepo, makeConfig(), makeGuard(),
        makeParserClient(makeClient([
          { photo: {}, views: 1000, reactions: { results: [{ count: 10, reaction: { emoticon: '🔥' } }] } },
          { photo: {}, views: 2000, reactions: { results: [{ count: 20, reaction: { emoticon: '🔥' } }] } },
          { photo: {}, views: 3000, reactions: { results: [{ count: 30, reaction: { emoticon: '💩' } }] } },
          { video: {}, views: 4000, reactions: { results: [{ count: 40, reaction: { emoticon: '🔥' } }] } },
          { photo: {}, views: 5000, reactions: { results: [] } },
          { photo: {}, views: 0, reactions: { results: [] } },
          { photo: {}, views: 9000, reactions: { results: [] } },
        ])),
        makeSettingsStub(), makeClock()
      );

      const freshMessages = [
        { photo: {}, views: 1000, reactions: { results: [{ count: 10, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 2000, reactions: { results: [{ count: 20, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 3000, reactions: { results: [{ count: 30, reaction: { emoticon: '💩' } }] } },
        { video: {}, views: 4000, reactions: { results: [{ count: 40, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 5000, reactions: { results: [] } },
        { photo: {}, views: 0, reactions: { results: [] } },
        { photo: {}, views: 9000, reactions: { results: [] } },
      ];
      const baseline = await service.seedBaselineFromHistory(source(), makeClient(freshMessages) as never);

      expect(baseline?.sampleSize).toBe(6);
      expect(sourceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ baseline: expect.objectContaining({ sampleSize: 6 }) })
      );
    });
  });

  describe('pruneWeakSources', () => {
    it('отключает источник без выбранных при полном reject-rate', async () => {
      sourceRepo.find.mockResolvedValue([source()]);
      observedRepo.find.mockResolvedValue([
        { status: 'rejected' },
        { status: 'rejected' },
        { status: 'rejected' },
      ]);

      const disabled = await service.pruneWeakSources();

      expect(disabled).toBe(1);
      expect(sourceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SourceStatus.DISABLED })
      );
    });

    it('источник с выбранными постами не трогается', async () => {
      sourceRepo.find.mockResolvedValue([source()]);
      observedRepo.find.mockResolvedValue([{ status: 'delivered' }]);
      const disabled = await service.pruneWeakSources();
      expect(disabled).toBe(0);
    });
  });
});
