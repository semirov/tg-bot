import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ObservedStatus } from '../constants/parser.constants';
import { ParserDiscoveryService } from './parser-discovery.service';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserMenuService } from './parser-menu.service';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSelectorService } from './parser-selector.service';
import { ParserEvaluatorService } from './parser-evaluator.service';
import { ParserCollectorService } from './parser-collector.service';
import { ParserClientService } from './parser-client.service';
import { ParserSettingsService } from './parser-settings.service';
import { ParserService } from './parser.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

jest.mock('imghash', () => ({
  hash: jest.fn().mockResolvedValue('abcd1234efgh5678'),
}));

jest.mock('../domain/tme-preview', () => {
  const actual = jest.requireActual('../domain/tme-preview') as Record<string, unknown>;
  return { ...actual, fetchTmePreview: jest.fn() };
});

const NOW = new Date('2026-09-19T12:00:00Z');
const clock = { now: jest.fn(() => NOW) } as never;
const random = { next: jest.fn(() => 0) } as never;
const save = async (value: unknown): Promise<unknown> => value;

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
  subscribers: null,
  err: null,
  baseline: null,
  statsUpdatedAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): any => ({
  id: 10,
  key: 'u:linked',
  username: 'linked',
  chatId: null,
  title: null,
  origin: 'cross_link',
  mentions: 1,
  sourceChatId: '-1008888888888',
  sourceMessageId: 42,
  mediaKind: 'photo',
  caption: null,
  views: 4000,
  reactions: 50,
  score: 4.2,
  status: ObservedStatus.SELECTED,
  imageHash: null,
  groupIds: null,
  createdAt: NOW,
  subscribers: null,
  errEstimate: null,
  postsPerDay: null,
  aiVerdict: null,
  verdict: 'pending',
  attempts: 0,
  reason: null,
  checkedAt: null,
  ...overrides,
});

const makeObservedRepo = (): any => ({
  findOne: jest.fn().mockResolvedValue(null),
  count: jest.fn().mockResolvedValue(0),
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(save),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
  })),
});

const makeSourceRepo = (): any => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  count: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(save),
});

const makeGuard = (): any => ({
  run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()),
  pace: jest.fn().mockResolvedValue(undefined),
});

const makeRegistryMock = (): any => ({
  repository: {
    findOne: jest.fn().mockResolvedValue(source()),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(save),
  },
  listCollectible: jest.fn().mockResolvedValue([]),
  listExcluded: jest.fn().mockResolvedValue([]),
  listPopular: jest.fn().mockResolvedValue([]),
  listAll: jest.fn().mockResolvedValue([]),
  countCollectible: jest.fn().mockResolvedValue(0),
  isOwnChannel: jest.fn((chatId: number) => chatId === -1001111111111),
  isExcluded: jest.fn().mockResolvedValue(false),
  addSource: jest.fn().mockResolvedValue({ id: 1 }),
  computeBaselineFor: jest.fn().mockResolvedValue({ vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 5 }),
  markSourceIgnored: jest.fn().mockResolvedValue(undefined),
  importSubscriptions: jest.fn().mockResolvedValue(0),
});

const makeParserClient = (client: unknown): any => ({ client: jest.fn(() => client) });

const makeSettings = (overrides: Record<string, unknown> = {}): any => ({
  current: {
    evalPreHours: 2,
    evalFinalHours: 12,
    candidateTtlHours: 48,
    hotScore: 4,
    minViews: 200,
    minReactions: 3,
    nvMin: 1.5,
    nrMin: 2,
    posShareMin: 0.25,
    aiEnabled: false,
    cringeMinViews: 100,
    cringeShareMin: 0.12,
    errMin: 0.15,
    aiRelevanceMin: 0.6,
    enabled: true,
    legacyEnabled: true,
    boostUntil: null,
    ...overrides,
  },
  enabled: true,
  update: jest.fn().mockResolvedValue(undefined),
  reset: jest.fn().mockResolvedValue(undefined),
  boostActive: jest.fn(() => false),
});

const makeSettingsStub = (): any => ({
  current: { maxSources: 50, idlePruneDays: 3 },
});

const makeConfig = (): any => ({
  memeChanelId: -1001111111111,
  cringeMemeChannelId: -1002222222222,
  bestMemeChanelId: -1003333333333,
  userRequestMemeChannel: -1004444444444,
  ownerId: 1,
});

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
    message: 'caption',
    peerId: new Api.PeerChannel({ channelId: bigInt('8888888888') }),
    photo,
    ...overrides,
  } as any;
};

describe('parser services branch backfill', () => {
  // ---------- delivery ----------
  it('delivery: imghash падает → доставляем без дедупа', async () => {
    const { hash } = jest.requireMock('imghash') as { hash: jest.Mock };
    hash.mockRejectedValueOnce(new Error('bad image'));

    const bot: any = { api: { sendPhoto: jest.fn().mockResolvedValue({ message_id: 1 }) } };
    const observedRepo = makeObservedRepo();
    const client = {
      getMessages: jest.fn().mockResolvedValue([mediaMessage()]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1])),
    };
    const dedup = { checkDuplicateSameLength: jest.fn(), createPublishedPostHash: jest.fn() };
    const row = candidate();
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient(client), dedup as never, observedRepo, clock
    );

    const result = await service.deliver(row);

    expect(result).toMatchObject({ ok: true });
    expect(dedup.checkDuplicateSameLength).not.toHaveBeenCalled();
    expect(row.imageHash).toBeNull();
  });

  it('delivery: подпись с null-метриками и источник без username/тайтла', () => {
    const bot: any = { api: {} };
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient({}), {} as never, makeObservedRepo(), clock
    );

    const caption = service.buildCaption(
      candidate({ views: null, reactions: null, score: null }),
      source({ username: null, title: null })
    );
    expect(caption).toContain('🧭 Парсер');
    expect(caption).not.toContain('👁');
    expect(caption).toContain('источник');

    const link = service.buildSourceLink(source({ username: null, title: null, chatId: '-1008888888888' }));
    expect(link).toContain('t.me/c/');
  });

  it('delivery: видео без обложки не хеширует дедуп', async () => {
    const video = new Api.Document({
      id: bigInt('777'),
      accessHash: bigInt('1'),
      fileReference: Buffer.from([]),
      date: 1000,
      attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 640, h: 640 })],
      mimeType: 'video/mp4',
      size: bigInt('1000'),
      dcId: 2,
      thumbs: [],
    });
    const bot: any = { api: { sendVideo: jest.fn().mockResolvedValue({ message_id: 1 }) } };
    const dedup = { checkDuplicateSameLength: jest.fn(), createPublishedPostHash: jest.fn() };
    const client = {
      getMessages: jest.fn().mockResolvedValue([{ id: 42, video, views: 4000 } as never]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1])),
    };
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient(client), dedup as never, makeObservedRepo(), clock
    );

    const result = await service.deliver(candidate({ mediaKind: 'video' }));

    expect(result).toMatchObject({ ok: true });
    expect(dedup.checkDuplicateSameLength).not.toHaveBeenCalled();
  });

  // ---------- discovery ----------
  it('discovery: пустой hit, уже в реестре по username и по chatId', async () => {
    const candidateRepo = makeObservedRepo();
    const sourceRepo = makeSourceRepo();
    const service = new ParserDiscoveryService(
      candidateRepo, sourceRepo, makeParserClient({}), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );

    await service.registerCrossLinks([{ username: null, chatId: null, origin: 'link' }]);
    expect(candidateRepo.create).not.toHaveBeenCalled();

    sourceRepo.findOne.mockImplementation(({ where }: any) =>
      Promise.resolve(where.username ? { id: 5 } : null)
    );
    await service.registerCrossLinks([{ username: 'known', chatId: null, origin: 'link' }]);
    expect(candidateRepo.create).not.toHaveBeenCalled();

    sourceRepo.findOne.mockImplementation(({ where }: any) =>
      Promise.resolve(where.username ? null : { id: 6 })
    );
    await service.registerCrossLinks([{ username: null, chatId: -100777, origin: 'fwd' }]);
    expect(candidateRepo.create).not.toHaveBeenCalled();
  });

  it('discovery: preview без просмотров → err null, нулевые подписчики → гейт err<', async () => {
    const fetchTmePreview = jest.requireMock('../domain/tme-preview').fetchTmePreview as jest.Mock;
    const candidateRepo = makeObservedRepo();
    candidateRepo.find.mockResolvedValue([candidate({})]);
    const client = { invoke: jest.fn().mockResolvedValue({}), getEntity: jest.fn() };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );

    fetchTmePreview.mockResolvedValue({
      username: 'linked',
      title: null,
      posts: [{ id: 1, views: 0, hasMedia: true, text: '', timeIso: null }],
    });

    const result = await service.checkCandidate(candidate({ chatId: '-1008888888888' }));
    expect(result.errEstimate).toBeNull();
    expect(result.verdict).toBe('pending');
    expect(result.reason).toBe('err-unavailable');
  });

  it('discovery: postsPerDay null не мешает гейту; ai nsfw отбрасывает', async () => {
    const fetchTmePreview = jest.requireMock('../domain/tme-preview').fetchTmePreview as jest.Mock;
    const candidateRepo = makeObservedRepo();
    const ai = { classifyChannel: jest.fn().mockResolvedValue({ category: 'memes', relevance: 0.9, nsfw: true }), rejectPostIfTrash: jest.fn() };
    const client = { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      makeRegistryMock(), makeSettings({ aiEnabled: true }), ai as never, clock
    );

    fetchTmePreview.mockResolvedValue({
      username: 'linked',
      title: 'T',
      posts: [{ id: 1, views: 3000, hasMedia: true, text: 'текст', timeIso: null }],
    });

    const result = await service.checkCandidate(candidate({ chatId: '-1008888888888' }));
    expect(result.verdict).toBe('rejected');
    expect(result.reason).toBe('ai:nsfw');
  });

  it('discovery: joinChannel без клиента → false; resolveUsername без chatId → null', async () => {
    const candidateRepo = makeObservedRepo();
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(undefined), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );

    expect(await service.approve(1, 'join')).toBeNull();
    candidateRepo.findOne.mockResolvedValue(candidate({ username: 'linked', chatId: null, verdict: 'ready' }));
    expect(await service.approve(1, 'join')).toBeNull();
  });

  it('discovery: approve с chatId из кандидата и провальным addSource', async () => {
    const candidateRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.addSource = jest.fn().mockResolvedValue(null);
    const client = {
      invoke: jest.fn().mockResolvedValue({}),
      getEntity: jest.fn().mockResolvedValue({ id: bigInt('8888888888') }),
    };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      registry, makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    candidateRepo.findOne.mockResolvedValue(
      candidate({ username: 'linked', chatId: '-1008888888888', verdict: 'ready' })
    );

    const result = await service.approve(1, 'web_only');
    expect(result?.verdict).toBe('approved');
    expect(registry.addSource).toHaveBeenCalled();
  });

  // ---------- menu ----------
  it('menu: getMenu без onModuleInit строит меню заново; заголовок/статистика', async () => {
    const settings = makeSettings();
    const registry = makeRegistryMock();
    const repo = makeObservedRepo();
    const bot: any = { api: { sendMessage: jest.fn() }, callbackQuery: jest.fn() };
    const service = new ParserMenuService(bot, repo, settings, registry);

    const menu = service.getMenu();
    expect(menu).toBeDefined();

    const stats = await service.statsLine();
    expect(stats).toContain('⏳ 0');
  });

  // ---------- guard ----------
  it('guard: ошибки без errorMessage/message; алерт не роняет', async () => {
    const bot: any = { api: { sendMessage: jest.fn().mockRejectedValue(new Error('no dm')) } };
    const guard = new ParserMtprotoGuard(bot, makeConfig(), random);

    const weird = { weird: true };
    await expect(guard.run('op', async () => { throw weird; })).resolves.toBeUndefined();

    const terminal = { errorMessage: undefined, toString: () => 'AUTH_KEY_UNREGISTERED' };
    await expect(guard.run('op2', async () => { throw terminal; })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  // ---------- registry ----------
  it('registry: диалог-не-канал и канал без username', async () => {
    const sourceRepo = makeSourceRepo();
    const client: any = {
      getDialogs: jest.fn().mockResolvedValue([
        { entity: { className: 'User', id: bigInt('123'), broadcast: false } },
        {
          entity: Object.assign(
            new Api.Channel({ id: bigInt('5555555555'), title: 'NoName', photo: undefined, date: 1 }),
            {
              broadcast: true,
            }
          ),
        },
      ]),
    };
    const service = new ParserRegistryService(
      sourceRepo, makeObservedRepo(), makeConfig(), makeGuard(), makeParserClient(client), makeSettingsStub(), clock
    );
    sourceRepo.findOne.mockResolvedValue(null);

    const created = await service.importSubscriptions();

    expect(created).toBe(1);
    expect(sourceRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '-1005555555555', username: null })
    );
  });

  it('registry: addSource с дефолтами категории/статуса', async () => {
    const sourceRepo = makeSourceRepo();
    const service = new ParserRegistryService(
      sourceRepo, makeObservedRepo(), makeConfig(), makeGuard(), makeParserClient({}), makeSettingsStub(), clock
    );

    const created = await service.addSource({ chatId: -1005555555555 });
    expect(created).toMatchObject({ category: 'memes', status: 'active' });
  });

  it('registry: getFullChannel по username, если нет rawChatId', async () => {
    const observedRepo = makeObservedRepo();
    const invoke = jest.fn().mockResolvedValue({ fullChat: { participantsCount: 5000 } });
    const service = new ParserRegistryService(
      makeSourceRepo(), observedRepo, makeConfig(), makeGuard(), makeParserClient({}), makeSettingsStub(), clock
    );

    const updated = await service.refreshSourceStats(
      source({ rawChatId: null, username: 'memes_source' }),
      { invoke } as never
    );

    expect(invoke).toHaveBeenCalled();
    expect(updated?.subscribers).toBe(5000);
  });

  it('registry: данные без fullChat и null-поля не роняют', async () => {
    const observedRepo = makeObservedRepo();
    const invoke = jest.fn().mockResolvedValue({});
    const service = new ParserRegistryService(
      makeSourceRepo(), observedRepo, makeConfig(), makeGuard(), makeParserClient({}), makeSettingsStub(), clock
    );

    const updated = await service.refreshSourceStats(source(), { invoke } as never);
    expect(updated?.subscribers).toBeNull();
  });

  // ---------- selector ----------
  it('selector: пустой пул → 0, занятость и cooldown блокируют', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const delivery = { deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }) };
    const bot: any = { api: { deleteMessage: jest.fn() } };
    const service = new ParserSelectorService(
      observedRepo, registry, delivery as never, makeSettings(), makeConfig(), bot, clock
    );
    (service as never as { pace: unknown }).pace = jest.fn().mockResolvedValue(undefined);

    expect(await service.dumpMore()).toBe(0);

    (service as never as { busy: boolean }).busy = true;
    expect(await service.dumpMore()).toBe(0);
    (service as never as { busy: boolean }).busy = false;

    (service as never as { lastDumpAt: number }).lastDumpAt = NOW.getTime();
    expect(await service.dumpMore()).toBe(0);
  });

  it('selector: ageBacklog без старых карточек → 0', async () => {
    const observedRepo = makeObservedRepo();
    const service = new ParserSelectorService(
      observedRepo, makeRegistryMock(), { deliver: jest.fn() } as never,
      makeSettings(), makeConfig(), { api: { deleteMessage: jest.fn() } } as never, clock
    );
    expect(await service.ageBacklog()).toBe(0);
  });

  // ---------- evaluator ----------
  it('evaluator: нет клиента → 0; кастомные реакции отсекаются', async () => {
    const observedRepo = makeObservedRepo();
    observedRepo.find.mockResolvedValue([]);
    const service = new ParserEvaluatorService(
      observedRepo, makeRegistryMock(), makeParserClient(undefined), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    expect(await service.evaluateDue()).toBe(0);

    const custom = {
      id: 42,
      views: 4000,
      reactions: { results: [{ reaction: {}, count: 5 }, { reaction: new Api.ReactionEmoji({ emoticon: '🔥' }), count: 'x' }] },
    } as never;
    expect(
      (service as never as { reactionResults: (m: unknown) => Array<{ emoji: string; count: number }> }).reactionResults(
        custom
      )
    ).toEqual([{ emoji: '🔥', count: 0 }]);
  });

  it('evaluator: кандидат с альбомом (groupIds) перечитывает группу', async () => {
    const observedRepo = makeObservedRepo();
    const client = {
      getMessages: jest.fn().mockResolvedValue([
        { id: 42, views: 4000, reactions: { results: [{ reaction: new Api.ReactionEmoji({ emoticon: '🔥' }), count: 40 }] } },
      ]),
    };
    const registry = makeRegistryMock();
    const service = new ParserEvaluatorService(
      observedRepo, registry, makeParserClient(client), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    observedRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
      candidate({ createdAt: new Date(NOW.getTime() - 13 * 3_600_000), groupIds: [43, 44] }),
    ]);

    expect(await service.evaluateDue()).toBe(1);
    expect(client.getMessages).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ids: [42, 43, 44] })
    );
  });

  it('evaluator: guard вернул undefined → кандидат пропущен', async () => {
    const observedRepo = makeObservedRepo();
    const client = { getMessages: jest.fn().mockResolvedValue(undefined) };
    const service = new ParserEvaluatorService(
      observedRepo, makeRegistryMock(), makeParserClient(client), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    observedRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
      candidate({ createdAt: new Date(NOW.getTime() - 13 * 3_600_000) }),
    ]);

    expect(await service.evaluateDue()).toBe(0);
    expect(observedRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ rejectReason: 'message-gone' })
    );
  });

  // ---------- collector ----------
  it('collector: live без chatId; альбом своего канала; альбом disabled-источника', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const parserClient = makeParserClient({ getMessages: jest.fn().mockResolvedValue([]) });
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), parserClient, { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    await service.onLiveEvent({ isChannel: true, message: mediaMessage() } as never);
    expect(observedRepo.create).not.toHaveBeenCalled();

    const ownMessage = mediaMessage();
    await service.onLiveEvent({
      isChannel: true,
      chatId: bigInt('-1001111111111'),
      message: { ...ownMessage, groupedId: bigInt('900') },
    } as never);
    registry.repository.findOne.mockResolvedValueOnce(source({ status: 'disabled' }));
    await service.onLiveEvent({
      isChannel: true,
      chatId: bigInt('-1008888888888'),
      message: { ...ownMessage, groupedId: bigInt('901') },
    } as never);
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    expect(observedRepo.create).not.toHaveBeenCalled();
  });

  it('collector: sweep c marked chatId и смешанным списком сообщений', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.listCollectible.mockResolvedValue([source({ rawChatId: null })]);
    const client = {
      getMessages: jest
        .fn()
        .mockResolvedValueOnce([null, { id: 1, message: '' }, mediaMessage({ id: 12, photo: undefined })] as never)
        .mockResolvedValueOnce([]),
    };
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), makeParserClient(client),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    expect(await service.sweepAll()).toBe(0);
    expect(client.getMessages).toHaveBeenCalledWith('memes_source', expect.anything());
  });

  it('collector: fetchMessage без клиента → undefined; markSourceError c не-Error', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const parserClient = makeParserClient(undefined);
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), parserClient,
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    expect(
      await (service as never as { fetchMessage: (id: unknown, msg: number) => Promise<unknown> }).fetchMessage(bigInt('1'), 5)
    ).toBeUndefined();

    registry.listCollectible.mockResolvedValue([source()]);
    const client = { getMessages: jest.fn().mockRejectedValue('строка-ошибка') };
    const service2 = new ParserCollectorService(
      observedRepo, registry, makeGuard(), makeParserClient(client),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );
    expect(await service2.sweepAll()).toBe(0);
    expect(registry.repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'строка-ошибка' })
    );
  });

  // ---------- parser.service ----------
  it('parser.service: onStats без клиента → выход', async () => {
    const settings = makeSettings();
    const registry = { listCollectible: jest.fn(), refreshSourceStats: jest.fn(), refreshCooldowns: jest.fn() };
    const service = new ParserService(
      settings, registry as never, {} as never, {} as never, {} as never, {} as never,
      { registerCallbacks: jest.fn() } as never, makeParserClient(undefined),
      { activeClient: undefined } as never,
      { callbackQuery: jest.fn(), on: jest.fn(), api: {} } as never,
      makeConfig()
    );

    await (service as never as { onStats(): Promise<void> }).onStats();

    expect(registry.listCollectible).not.toHaveBeenCalled();
  });

  // ---------- settings ----------
  it('settings: enabled=false в кэше при env включённом', async () => {
    const repo: any = { findOne: jest.fn().mockResolvedValue({ id: 1, enabled: false }), save: jest.fn() };
    const service = new ParserSettingsService(repo, { parserEnabled: true } as never);
    await service.onModuleInit();
    expect(service.enabled).toBe(false);
  });

  it('ParserClientService: client() отдаёт активный клиент', () => {
    const client = { connected: true };
    const service = new ParserClientService({ activeClient: client } as never);
    expect(service.client()).toBe(client);
  });
});
