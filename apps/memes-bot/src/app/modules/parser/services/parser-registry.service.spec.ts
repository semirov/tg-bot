import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { COOLDOWN_DAYS, PAUSE_WEIGHT } from '../domain/parser-source-weight';
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
  current: { maxSources: 50, idlePruneDays: 3 },
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
  takenTotal: 0,
  ignoredTotal: 0,
  softIgnoredTotal: 0,
  cooldownCount: 0,
  cooldownUntil: null,
  excluded: false,
  excludedAt: null,
  weight: 1,
  statsUpdatedAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

const build = (
  deps: { sourceRepo?: any; observedRepo?: any; guard?: any; parserClient?: any; clock?: any } = {}
): { service: ParserRegistryService; sourceRepo: any; observedRepo: any } => {
  const sourceRepo = deps.sourceRepo ?? makeSourceRepo();
  const observedRepo = deps.observedRepo ?? makeObservedRepo();
  const service = new ParserRegistryService(
    sourceRepo,
    observedRepo,
    makeConfig(),
    deps.guard ?? makeGuard(),
    deps.parserClient ?? makeParserClient({ getDialogs: jest.fn().mockResolvedValue([]) }),
    makeSettingsStub(),
    deps.clock ?? makeClock()
  );
  return { service, sourceRepo, observedRepo };
};

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

  it('listCollectible берёт active и web_only без исключённых', async () => {
    await service.listCollectible();
    expect(sourceRepo.find).toHaveBeenCalledWith({
      where: [
        { status: SourceStatus.ACTIVE, excluded: false },
        { status: SourceStatus.WEB_ONLY, excluded: false },
      ],
    });
  });

  it('countCollectible считает active/web_only без исключённых', async () => {
    sourceRepo.count.mockResolvedValue(3);
    expect(await service.countCollectible()).toBe(3);
    expect(sourceRepo.count).toHaveBeenCalledWith({
      where: [
        { status: SourceStatus.ACTIVE, excluded: false },
        { status: SourceStatus.WEB_ONLY, excluded: false },
      ],
    });
  });

    it('listExcluded/listPopular', async () => {
    await service.listExcluded();
    expect(sourceRepo.find).toHaveBeenCalledWith({ where: { excluded: true }, order: { excludedAt: 'DESC' } });

    await service.listPopular(5, 10);
    expect(sourceRepo.find).toHaveBeenCalledWith({
      where: { excluded: false },
      order: { takenTotal: 'DESC', weight: 'DESC', id: 'ASC' },
      take: 5,
      skip: 10,
    });

    await service.listPopular();
    expect(sourceRepo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 10, skip: 0 })
    );
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

  it('toggleStatus/setCategory: нет источника → null', async () => {
    sourceRepo.findOne.mockResolvedValue(null);
    expect(await service.toggleStatus(99)).toBeNull();
    expect(await service.setCategory(99, SourceCategory.CRINGE)).toBeNull();
  });

  it('isExcluded: true/false/нет источника', async () => {
    sourceRepo.findOne.mockResolvedValueOnce(source({ excluded: true }));
    expect(await service.isExcluded('-100777')).toBe(true);
    sourceRepo.findOne.mockResolvedValueOnce(source({ excluded: false }));
    expect(await service.isExcluded(-100777)).toBe(false);
    sourceRepo.findOne.mockResolvedValueOnce(null);
    expect(await service.isExcluded(-100777)).toBe(false);
  });

  it('importSubscriptions: guard не смог получить диалоги → 0', async () => {
    const guard = makeGuard();
    guard.run.mockResolvedValue(undefined);
    parserClient = makeParserClient({});
    service = new ParserRegistryService(sourceRepo, observedRepo, makeConfig(), guard, parserClient, makeSettingsStub(), makeClock());
    expect(await service.importSubscriptions()).toBe(0);
  });

  it('refreshSourceStats: резолвит канал по marked chatId', async () => {
    observedRepo.find.mockResolvedValue([]);
    const invoke = jest.fn().mockResolvedValue({ fullChat: { participantsCount: 4200 } });
    const updated = await service.refreshSourceStats(
      source({ rawChatId: null, username: null, chatId: '-1008888888888' }),
      { invoke } as never
    );
    const request = invoke.mock.calls[0]?.[0] as { channel?: unknown };
    expect(String(request.channel)).toBe('-1008888888888');
    expect(updated?.subscribers).toBe(4200);
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

    it('канал без username/title пишется с null', async () => {
      parserClient.client().getDialogs.mockResolvedValue([
        {
          entity: Object.assign(
            new Api.Channel({ id: bigInt('5555555555'), title: undefined, photo: undefined, date: 1 }),
            { broadcast: true }
          ),
        },
      ]);
      sourceRepo.findOne.mockResolvedValue(null);
      expect(await service.importSubscriptions()).toBe(1);
      expect(sourceRepo.create).toHaveBeenCalledWith(expect.objectContaining({ title: null, username: null }));
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

    it('передаёт категорию/статус/rawChatId', async () => {
      await service.addSource({
        chatId: -100666,
        rawChatId: 666,
        username: 'x',
        title: 'T',
        status: SourceStatus.WEB_ONLY,
        category: SourceCategory.CRINGE,
      });
      expect(sourceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-100666',
          rawChatId: '666',
          status: SourceStatus.WEB_ONLY,
          category: SourceCategory.CRINGE,
        })
      );
    });

    it('исключённый источник не добавляется → null', async () => {
      sourceRepo.findOne.mockResolvedValue(source({ chatId: '-100555', excluded: true }));
      expect(await service.addSource({ chatId: -100555 })).toBeNull();
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('markSourceTaken', () => {
    it('растит takenTotal, lastTakenAt и вес источника', async () => {
      const row = source({ takenTotal: 0, weight: 1 });
      sourceRepo.findOne.mockResolvedValue(row);

      await service.markSourceTaken('-100777');

      expect(row.takenTotal).toBe(1);
      expect(row.lastTakenAt).toEqual(NOW);
      expect(row.weight).toBeGreaterThan(1);
      expect(sourceRepo.save).toHaveBeenCalledWith(row);
    });

    it('неизвестный источник — молча выходим', async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      await service.markSourceTaken('-100000');
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('markSourceIgnored', () => {
    it('жёсткий игнор растит ignoredTotal и роняет вес', async () => {
      const row = source({ takenTotal: 0, ignoredTotal: 2, weight: 1 });
      sourceRepo.findOne.mockResolvedValue(row);
      await service.markSourceIgnored('-100777');
      expect(row.ignoredTotal).toBe(3);
      expect(row.lastIgnoredAt).toEqual(NOW);
      expect(row.weight).toBeLessThan(1);
    });

    it('мягкий игнор растит softIgnoredTotal', async () => {
      const row = source({ takenTotal: 0, softIgnoredTotal: 0, weight: 1 });
      sourceRepo.findOne.mockResolvedValue(row);
      await service.markSourceIgnored('-100777', false);
      expect(row.softIgnoredTotal).toBe(1);
      expect(row.ignoredTotal).toBe(0);
    });

    it('низкий вес уводит источник в cooldown и продлевает следующую паузу', async () => {
      const row = source({
        takenTotal: 0,
        ignoredTotal: 9,
        cooldownCount: 2,
        cooldownUntil: new Date(NOW.getTime() - 3_600_000),
      });
      sourceRepo.findOne.mockResolvedValue(row);
      await service.markSourceIgnored('-100777');
      expect(row.ignoredTotal).toBe(10);
      expect(row.cooldownUntil).toBeInstanceOf(Date);
      // cooldownCount=2 → пауза 7д + 0.5*7д
      expect(row.cooldownUntil.getTime()).toBe(NOW.getTime() + COOLDOWN_DAYS * 1.5 * 86_400_000);
    });

    it('первый уход в паузу увеличивает cooldownCount', async () => {
      const row = source({ takenTotal: 0, ignoredTotal: 9, cooldownCount: 0 });
      sourceRepo.findOne.mockResolvedValue(row);
      await service.markSourceIgnored('-100777');
      expect(row.cooldownCount).toBe(1);
    });

    it('неизвестный источник — молча выходим', async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      await service.markSourceIgnored('-100000');
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('applyInterest с null-полями', () => {
    it('null-счётчики трактуются как 0', async () => {
      const row = source({
        takenTotal: null,
        ignoredTotal: null,
        softIgnoredTotal: null,
        lastIgnoredAt: null,
        cooldownCount: null,
      });
      sourceRepo.findOne.mockResolvedValue(row);

      await service.markSourceTaken('-100777');
      expect(row.takenTotal).toBe(1);

      await service.markSourceIgnored('-100777', false);
      expect(row.softIgnoredTotal).toBe(1);

      await service.markSourceIgnored('-100777', true);
      expect(row.ignoredTotal).toBe(1);
    });

    it('cooldownCount null не мешает продлению паузы', async () => {
      const row = source({
        ignoredTotal: 9,
        cooldownCount: null,
        cooldownUntil: new Date(NOW.getTime() - 1000),
      });
      sourceRepo.findOne.mockResolvedValue(row);
      await service.markSourceIgnored('-100777');
      expect(row.cooldownUntil).toBeInstanceOf(Date);
    });

    it('restoreSource с null-полями и пустым title', async () => {
      const row = source({
        id: 8,
        excluded: true,
        username: null,
        rawChatId: null,
        title: null,
        weight: null,
        ignoredTotal: null,
        softIgnoredTotal: null,
      });
      sourceRepo.findOne.mockResolvedValue(row);
      const result = await service.restoreSource(8);
      expect(result?.status).toBe(SourceStatus.WEB_ONLY);
      expect(result?.weight).toBeGreaterThanOrEqual(1);
    });

    it('excludeSource с пустым title логирует chatId', async () => {
      const row = source({ id: 9, title: null });
      sourceRepo.findOne.mockResolvedValue(row);
      await service.excludeSource(9);
      expect(row.excluded).toBe(true);
    });
  });

  describe('refreshCooldowns', () => {
    it('пропускает источники без паузы и с активной паузой', async () => {
      sourceRepo.find.mockResolvedValue([
        source({ id: 1, cooldownUntil: null }),
        source({ id: 2, cooldownUntil: new Date(NOW.getTime() + 3_600_000) }),
      ]);
      expect(await service.refreshCooldowns()).toBe(0);
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });

    it('истёкшую паузу снимает вдвое и возвращает источник', async () => {
      const row = source({
        id: 3,
        ignoredTotal: 8,
        softIgnoredTotal: 5,
        cooldownUntil: new Date(NOW.getTime() - 3_600_000),
      });
      sourceRepo.find.mockResolvedValue([row]);

      expect(await service.refreshCooldowns()).toBe(1);
      expect(row.ignoredTotal).toBe(4);
      expect(row.softIgnoredTotal).toBe(2);
      expect(row.cooldownUntil).toBeNull();
      expect(row.lastIgnoredAt).toBeNull();
      expect(sourceRepo.save).toHaveBeenCalledWith(row);
    });

    it('не уходит в паузу повторно и не растит cooldownCount', async () => {
      const row = source({
        id: 5,
        ignoredTotal: 19,
        softIgnoredTotal: 0,
        cooldownCount: 1,
        cooldownUntil: new Date(NOW.getTime() - 3_600_000),
      });
      sourceRepo.find.mockResolvedValue([row]);

      expect(await service.refreshCooldowns()).toBe(1);
      expect(row.ignoredTotal).toBe(9);
      expect(row.cooldownUntil).toBeNull();
      expect(row.cooldownCount).toBe(1);
      expect(row.weight).toBeLessThan(PAUSE_WEIGHT);
    });

    it('null-счётчики и пустой title не роняют возврат из паузы', async () => {
      const row = source({
        id: 4,
        ignoredTotal: null,
        softIgnoredTotal: null,
        title: null,
        cooldownUntil: new Date(NOW.getTime() - 3_600_000),
      });
      sourceRepo.find.mockResolvedValue([row]);

      expect(await service.refreshCooldowns()).toBe(1);
      expect(row.ignoredTotal).toBe(0);
      expect(row.softIgnoredTotal).toBe(0);
    });
  });

  describe('excludeSource/restoreSource', () => {
    it('excludeSource помечает источник и отключает его', async () => {
      const row = source({ id: 5 });
      sourceRepo.findOne.mockResolvedValue(row);
      const result = await service.excludeSource(5);
      expect(result).toBe(row);
      expect(row).toMatchObject({
        excluded: true,
        status: SourceStatus.DISABLED,
        excludedAt: NOW,
        lastError: 'excluded-by-owner',
      });
    });

    it('excludeSource: нет источника → null', async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      expect(await service.excludeSource(99)).toBeNull();
    });

    it('restoreSource сбрасывает чёрный список и возвращает active для username', async () => {
      const row = source({ id: 6, excluded: true, username: 'x', rawChatId: null, weight: 0.2, ignoredTotal: 9, softIgnoredTotal: 3, cooldownCount: 2 });
      sourceRepo.findOne.mockResolvedValue(row);
      const result = await service.restoreSource(6);
      expect(result).toBe(row);
      expect(row).toMatchObject({
        excluded: false,
        excludedAt: null,
        ignoredTotal: 0,
        softIgnoredTotal: 0,
        cooldownCount: 0,
        lastIgnoredAt: null,
        cooldownUntil: null,
        status: SourceStatus.ACTIVE,
        lastError: null,
      });
      expect(row.weight).toBeGreaterThanOrEqual(1);
    });

    it('restoreSource без username/rawChatId → web_only', async () => {
      const row = source({ id: 7, excluded: true, username: null, rawChatId: null, weight: 2 });
      sourceRepo.findOne.mockResolvedValue(row);
      const result = await service.restoreSource(7);
      expect(result?.status).toBe(SourceStatus.WEB_ONLY);
      expect(row.weight).toBeGreaterThanOrEqual(1);
    });

    it('restoreSource: нет источника → null', async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      expect(await service.restoreSource(99)).toBeNull();
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

    it('свежая статистика не перезапрашивается', async () => {
      observedRepo.find.mockResolvedValue([]);
      const invoke = jest.fn();
      await service.refreshSourceStats(source({ statsUpdatedAt: NOW }), { invoke } as never);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('invoke без fullChat → подписчики не пишутся', async () => {
      observedRepo.find.mockResolvedValue([]);
      const invoke = jest.fn().mockResolvedValue({});
      const updated = await service.refreshSourceStats(source(), { invoke } as never);
      expect(updated?.subscribers).toBeNull();
    });

    it('нет базлайна при известных подписчиках → ERR не пересчитывается', async () => {
      observedRepo.find.mockResolvedValue([{ views: 100, reactions: 1, metrics: null }]);
      const invoke = jest.fn().mockResolvedValue({ fullChat: { participantsCount: 5000 } });
      const updated = await service.refreshSourceStats(source({ err: 0.3 }), { invoke } as never);
      expect(updated?.subscribers).toBe(5000);
      expect(updated?.err).toBe(0.3);
    });
  });

  describe('seedBaselineFromHistory', () => {
    const makeClient = (messages: unknown[]) => ({ getMessages: jest.fn().mockResolvedValue(messages) });

    it('нет peer → null', async () => {
      const { service: svc } = build();
      expect(
        await svc.seedBaselineFromHistory(source({ rawChatId: null, username: null }), { getMessages: jest.fn() } as never)
      ).toBeNull();
    });

    it('guard вернул undefined → null', async () => {
      const guard = makeGuard();
      guard.run.mockResolvedValue(undefined);
      const { service: svc } = build({ guard });
      expect(await svc.seedBaselineFromHistory(source(), makeClient([]) as never)).toBeNull();
    });

    it('мало постов с просмотрами → null', async () => {
      const { service: svc } = build();
      expect(
        await svc.seedBaselineFromHistory(
          source(),
          makeClient([
            { photo: {}, views: 100, reactions: { results: [] } },
            { photo: {}, views: 200, reactions: { results: [] } },
          ]) as never
        )
      ).toBeNull();
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
      const { service: svc } = build();
      expect(await svc.seedBaselineFromHistory(source(), makeClient(dirty) as never)).toMatchObject({
        sampleSize: 6,
      });
    });

    it('успех: считает базлайн и сохраняет в источник', async () => {
      const { service: svc, sourceRepo: repo } = build();
      const messages = [
        { photo: {}, views: 1000, reactions: { results: [{ count: 10, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 2000, reactions: { results: [{ count: 20, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 3000, reactions: { results: [{ count: 30, reaction: { emoticon: '💩' } }] } },
        { video: {}, views: 4000, reactions: { results: [{ count: 40, reaction: { emoticon: '🔥' } }] } },
        { photo: {}, views: 5000, reactions: { results: [] } },
        { photo: {}, views: 0, reactions: { results: [] } },
        { photo: {}, views: 9000, reactions: { results: [] } },
      ];
      const baseline = await svc.seedBaselineFromHistory(source(), makeClient(messages) as never);

      expect(baseline?.sampleSize).toBe(6);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ baseline: expect.objectContaining({ sampleSize: 6 }) })
      );
    });
  });

  describe('computeBaselineFor', () => {
    it('меньше 5 постов → null', async () => {
      observedRepo.find.mockResolvedValue([{ views: 100, reactions: 1, metrics: null }]);
      expect(await service.computeBaselineFor(source())).toBeNull();
    });

    it('считает базлайн из собранных постов', async () => {
      observedRepo.find.mockResolvedValue([
        { views: 100, reactions: 1, metrics: { posShare: 0.5 } },
        { views: 200, reactions: 2, metrics: { posShare: 0.4 } },
        { views: 300, reactions: 3, metrics: { posShare: 0.3 } },
        { views: 400, reactions: 4, metrics: { posShare: 0.2 } },
        { views: 500, reactions: 5, metrics: null },
      ]);
      const baseline = await service.computeBaselineFor(source());
      expect(baseline?.sampleSize).toBe(5);
    });

    it('null-реакции и null-метрики трактуются как 0', async () => {
      observedRepo.find.mockResolvedValue([
        { views: 100, reactions: null, metrics: null },
        { views: 200, reactions: null, metrics: null },
        { views: 300, reactions: null, metrics: null },
        { views: 400, reactions: null, metrics: null },
        { views: 500, reactions: null, metrics: null },
      ]);
      const baseline = await service.computeBaselineFor(source());
      expect(baseline?.sampleSize).toBe(5);
    });
  });
});
