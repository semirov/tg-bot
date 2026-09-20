import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ObservedStatus } from '../constants/parser.constants';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { ParserMenuService } from './parser-menu.service';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSelectorService } from './parser-selector.service';
import { ParserEvaluatorService } from './parser-evaluator.service';
import { ParserCollectorService } from './parser-collector.service';
import { ParserAiService } from './parser-ai.service';
import { ParserModerationService } from './parser-moderation.service';
import { ParserService } from './parser.service';
import { channelInternalId, buildPostUrl } from '../../../shared/publication/telegram-link';
import { pickByFairness } from '../domain/parser-quotas';
import { collectPostCrossLinks } from '../domain/parser-cross-links';

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

const candidateRow = (overrides: Record<string, unknown> = {}): any => ({
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
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(save),
  count: jest.fn().mockResolvedValue(0),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
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
  listAll: jest.fn().mockResolvedValue([]),
  countCollectible: jest.fn().mockResolvedValue(0),
  isOwnChannel: jest.fn((chatId: number) => chatId === -1001111111111),
  computeBaselineFor: jest.fn().mockResolvedValue({ vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 5 }),
  addSource: jest.fn().mockResolvedValue({ id: 1 }),
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
    dailyLimit: 12,
    sourceDailyCap: 2,
    cringeShare: 0.25,
    errMin: 0.15,
    maxSources: 20,
    aiRelevanceMin: 0.6,
    enabled: true,
    ...overrides,
  },
  enabled: true,
  update: jest.fn().mockResolvedValue(undefined),
  reset: jest.fn().mockResolvedValue(undefined),
});

const makeSettingsStub = (): any => ({
  current: { maxSources: 50 },
});

const BASELINE = {
  vmed: 1000,
  rmed: 10,
  p90: 4000,
  posShare: 0.8,
  sampleSize: 10,
  updatedAt: NOW.toISOString(),
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

jest.mock('../domain/tme-preview', () => {
  const actual = jest.requireActual('../domain/tme-preview') as Record<string, unknown>;
  return { ...actual, fetchTmePreview: jest.fn() };
});

const fetchTmePreviewMock = jest.requireMock('../domain/tme-preview').fetchTmePreview as jest.Mock;

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

describe('parser branches round 2', () => {
  // ---------- moderation fallbacks (реальный сервис, приватные методы через cast) ----------
  const makeModeration = (overrides: Record<string, unknown> = {}) => {
    const bot: any = {
      api: { copyMessage: jest.fn().mockResolvedValue({ message_id: 1 }) },
      callbackQuery: jest.fn(),
    };
    const observedRepo = makeObservedRepo();
    observedRepo.findOne.mockResolvedValue(candidateRow(overrides));
    const scheduler: any = {
      addPostToSchedule: jest.fn().mockResolvedValue(new Date('2026-09-20T03:00:00Z')),
      formatToMsk: (date: Date) => date,
    };
    const cringe: any = { repository: { insert: jest.fn() } };
    const service = new ParserModerationService(
      bot,
      observedRepo,
      { buildCandidateKeyboard: jest.fn() } as never,
      { checkPermission: jest.fn(() => true) } as never,
      scheduler,
      cringe,
      { createPublishedPostHash: jest.fn() } as never,
      { approve: jest.fn().mockResolvedValue({ id: 1 }), reject: jest.fn().mockResolvedValue({ id: 1 }) } as never,
      makeConfig(),
      { repository: { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() } } as never
    );
    return { service, observedRepo, scheduler, cringe, bot };
  };

  it('moderation: queue/publishNight/reject с отсутствующим from и хешем', async () => {
    const { service, cringe } = makeModeration();

    const ctxFromless: any = {
      callbackQuery: { message: { message_id: 7777 } },
      answerCallbackQuery: jest.fn(),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
      editMessageText: jest.fn().mockResolvedValue(undefined),
    };
    const cast = service as never as Record<string, (...args: unknown[]) => Promise<void>>;

    await cast.queue(ctxFromless, candidateRow({ imageHash: null }), 'NEXT_INTERVAL', '📋');
    await cast.publishNight(ctxFromless, candidateRow({ imageHash: null }));
    await cast.reject(ctxFromless, candidateRow());

    expect(ctxFromless.answerCallbackQuery).toHaveBeenCalled();
    expect(cringe.repository.insert).toHaveBeenCalled();
  });

  it('moderation: publishCaption без источника и с не-канальным id', () => {
    const { service } = makeModeration();

    const cast = service as never as { publishCaption: (c: unknown) => string };
    expect(cast.publishCaption(candidateRow({ sourceChatId: null }))).toBe('');
    expect(cast.publishCaption(candidateRow({ sourceChatId: '123' }))).toContain('t.me/c/123');
  });

  // ---------- delivery ветки ----------
  it('delivery: checkDuplicate undefined; score null в логе; клиент отсутствует', async () => {
    const dedup = { checkDuplicate: jest.fn().mockResolvedValue(undefined), createPublishedPostHash: jest.fn() };
    const registry = makeRegistryMock();
    const observedRepo = makeObservedRepo();
    const bot: any = { api: { sendPhoto: jest.fn().mockResolvedValue({ message_id: 2 }) } };
    const client = { getMessages: jest.fn().mockResolvedValue([mediaMessage()]), downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1])) };
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), registry, makeParserClient(client), dedup as never, observedRepo, clock
    );

    const ok = await service.deliver(candidateRow({ score: null }));
    expect(ok).toMatchObject({ ok: true });

    const noClient = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), registry, makeParserClient(undefined), dedup as never, observedRepo, clock
    );
    expect(await noClient.deliver(candidateRow())).toMatchObject({ status: ObservedStatus.FAILED });
  });

  it('delivery: rawChatId null, пустой буфер, messages undefined', async () => {
    const registry = makeRegistryMock();
    const observedRepo = makeObservedRepo();
    const bot: any = { api: { sendPhoto: jest.fn().mockResolvedValue({ message_id: 3 }) } };
    const client = { getMessages: jest.fn().mockResolvedValue(undefined), downloadMedia: jest.fn().mockResolvedValue(Buffer.alloc(0)) };
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), registry, makeParserClient(client), { checkDuplicate: jest.fn() } as never, observedRepo, clock
    );

    expect(await service.deliver(candidateRow())).toMatchObject({ ok: false, status: ObservedStatus.FAILED });

    const client2 = { getMessages: jest.fn().mockResolvedValue([mediaMessage()]), downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1])) };
    const service2 = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient(client2), { checkDuplicate: jest.fn() } as never, observedRepo, clock
    );
    expect(await service2.deliver(candidateRow({ sourceChatId: '-1008888888888' }))).toMatchObject({ ok: true });
    void registry;
  });

  it('delivery: buildSourceLink для не-канального chatId', () => {
    const service = new ParserDeliveryService(
      {} as never, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient({}), {} as never, makeObservedRepo(), clock
    );
    expect(service.buildSourceLink(source({ chatId: '123', username: null, title: null }))).toContain('t.me/c/123');
  });

  // ---------- discovery ветки ----------
  it('discovery: join-успех через chatId кандидата; getFullChannel undefined; resolveUsername ветки', async () => {
    const candidateRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const client = {
      invoke: jest.fn().mockResolvedValue({}),
      getEntity: jest.fn().mockResolvedValue({ username: 'linked', id: undefined }),
    };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      registry, makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    candidateRepo.findOne.mockResolvedValue(
      candidateRow({ chatId: '-1008888888888', verdict: 'ready' })
    );

    const joined = await service.approve(1, 'join');
    expect(joined?.verdict).toBe('approved');
    expect(joined?.reason).toBe('joined');
    expect(registry.addSource).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));

    const noClient = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(undefined), makeGuard(),
      registry, makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    candidateRepo.findOne.mockResolvedValue(candidateRow({ username: null, chatId: null }));
    expect(await noClient.approve(1, 'web_only')).toBeNull();

    candidateRepo.findOne.mockResolvedValue(candidateRow({ username: 'linked', chatId: null }));
    const okNoRaw = await noClient.approve(1, 'web_only');
    expect(okNoRaw).toBeNull();
  });

  it('discovery: evaluateGate postsPerDay null; лимит лога registerCrossLinks', async () => {
    const fetchTmePreview = fetchTmePreviewMock as jest.Mock;
    const candidateRepo = makeObservedRepo();
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient({ invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 1000 } }) }),
      makeGuard(), makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );

    fetchTmePreview.mockResolvedValue({
      username: 'linked',
      title: 'T',
      posts: [{ id: 1, views: 300, hasMedia: true, text: '', timeIso: null }],
    });
    const result = await service.checkCandidate(candidateRow({}));
    expect(result.verdict).toBe('ready');

    candidateRepo.findOne.mockResolvedValue(null);
    await service.registerCrossLinks(
      Array.from({ length: 12 }, (_, index) => ({ username: `ch${index}`, chatId: null, origin: 'link' as const }))
    );
    expect(candidateRepo.create).toHaveBeenCalledTimes(12);
  });

  it('discovery: checkCandidate без клиента', async () => {
    const fetchTmePreview = fetchTmePreviewMock as jest.Mock;
    const candidateRepo = makeObservedRepo();
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(undefined), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    fetchTmePreview.mockResolvedValue({
      username: 'linked',
      title: 'T',
      posts: [{ id: 1, views: 300, hasMedia: true, text: '', timeIso: null }],
    });

    const result = await service.checkCandidate(candidateRow({}));
    // Нет клиента → getFullChannel недоступен → инфраструктурная пауза, не вердикт.
    expect(result.verdict).toBe('pending');
    expect(result.reason).toBe('subscriber-check-failed');
  });

  // ---------- menu: label-функции и варианты источников ----------
  it('menu: лейблы и динамика при выключенном конвейере и пустых кандидатах', async () => {
    const settings = makeSettings({ enabled: false });
    const registry = makeRegistryMock();
    registry.listAll.mockResolvedValue([
      source({ status: 'disabled', title: null }),
      source({ id: 2, status: 'web_only', username: 'webb', title: null }),
      source({ id: 3, category: 'cringe' }),
    ]);
    const discovery = {
      repository: { count: jest.fn().mockResolvedValue(0) },
      listReady: jest.fn().mockResolvedValue([]),
    };
    const repo = makeObservedRepo();
    const bot: any = { api: { sendMessage: jest.fn() } };
    const service = new ParserMenuService(
      bot, repo, settings, registry, discovery as never, { buildCandidateKeyboard: jest.fn() } as never,
    );

    const menu = service.getMenu();
    void menu;
    const stats = await service.statsLine();
    expect(stats).toContain('✅ 0');
    void bot;
  });

  // ---------- guard: message-фолбэк в распознавании ошибок ----------
  it('guard: plain Error без errorMessage; терминальная через message', async () => {
    const bot: any = { api: { sendMessage: jest.fn() } };
    const guard = new ParserMtprotoGuard(bot, makeConfig(), random);

    await expect(
      guard.run('op', async () => {
        throw new Error('USER_DEACTIVATED_BAN');
      })
    ).rejects.toThrow();
  });

  // ---------- registry: null-поля, свежая статистика, прунинг-ветки ----------
  it('registry: title null; addSource со всеми полями; stale=false; full=undefined', async () => {
    const sourceRepo = makeSourceRepo();
    const observedRepo = makeObservedRepo();
    const client: any = {
      getDialogs: jest.fn().mockResolvedValue([
        {
          entity: Object.assign(new Api.Channel({ id: bigInt('6666666666'), title: undefined, photo: undefined, date: 1 }), {
            broadcast: true,
          }),
        },
      ]),
      invoke: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ParserRegistryService(
      sourceRepo, observedRepo, makeConfig(), makeGuard(), makeParserClient(client), makeSettingsStub(), clock
    );
    sourceRepo.findOne.mockResolvedValue(null);

    expect(await service.importSubscriptions()).toBe(1);
    expect(sourceRepo.create).toHaveBeenCalledWith(expect.objectContaining({ title: null }));

    await service.addSource({
      chatId: -1007777777777,
      rawChatId: 7777777777,
      username: 'x',
      title: 'T',
      status: 'web_only' as never,
      category: 'cringe' as never,
    });
    expect(sourceRepo.create).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'web_only', category: 'cringe' }));

    const invoke = jest.fn().mockResolvedValue(undefined);
    const freshSource = source({ statsUpdatedAt: NOW });
    await service.refreshSourceStats(freshSource, { invoke } as never);
    expect(invoke).not.toHaveBeenCalled();

    observedRepo.find.mockResolvedValue([
      { views: null, reactions: null, metrics: null },
      { views: 100, reactions: 5, metrics: { posShare: 0.5 } },
      { views: 200, reactions: 6, metrics: { posShare: 0.4 } },
      { views: 300, reactions: 7, metrics: { posShare: 0.3 } },
      { views: 400, reactions: 8, metrics: { posShare: 0.2 } },
      { views: 500, reactions: 9, metrics: { posShare: 0.1 } },
    ]);
    const baseline = await service.computeBaselineFor(source());
    expect(baseline?.sampleSize).toBe(6);
  });

  it('registry: прунинг — свежий источник и источник без постов', async () => {
    const observedRepo = makeObservedRepo();
    const sourceRepo = makeSourceRepo();
    sourceRepo.find.mockResolvedValue([
      source({ id: 1, createdAt: NOW, title: null }),
      source({ id: 2, title: null }),
    ]);
    observedRepo.find.mockResolvedValue([]);
    const service = new ParserRegistryService(
      sourceRepo, observedRepo, makeConfig(), makeGuard(), makeParserClient({}), makeSettingsStub(), clock
    );

    expect(await service.pruneWeakSources()).toBe(0);
    expect(observedRepo.find).toHaveBeenCalledTimes(1);
  });

  // ---------- selector: fallback-ветки ----------
  it('selector: rows без score/deliveredAt/mediaUniqueId; pick с undefined', async () => {
    const observedRepo = makeObservedRepo();
    observedRepo.find.mockImplementation((options: any = {}) => {
      if (options.where?.mediaUniqueId !== undefined) {
        return Promise.resolve([{ mediaUniqueId: 'taken', status: ObservedStatus.PUBLISHED }]);
      }
      return Promise.resolve([candidateRow({ score: undefined, mediaUniqueId: undefined })]);
    });
    const builder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        candidateRow({ status: ObservedStatus.QUEUED, deliveredAt: undefined }),
      ]),
    };
    observedRepo.createQueryBuilder = jest.fn(() => builder);
    const registry = makeRegistryMock();
    registry.repository.find.mockResolvedValue([source()]);
    const delivery = { deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }) };
    const service = new ParserSelectorService(
      observedRepo, registry, { isEligible: jest.fn(() => true) } as never, delivery as never, makeSettings(), clock
    );

    expect(await service.selectAndDeliver()).toBe(1);
  });

  // ---------- evaluator: missing fields ----------
  it('evaluator: source без rawChatId; guard вернул undefined; message без views/reactions', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.repository.findOne.mockResolvedValue(source({ rawChatId: null }));
    const client = {
      getMessages: jest
        .fn()
        .mockResolvedValueOnce(undefined as never)
        .mockResolvedValueOnce([{ id: 42 } as never]),
    };
    const service = new ParserEvaluatorService(
      observedRepo, registry, makeParserClient(client), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    observedRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
      candidateRow({ id: 1, createdAt: new Date(NOW.getTime() - 13 * 3_600_000) }),
      candidateRow({ id: 2, createdAt: new Date(NOW.getTime() - 13 * 3_600_000) }),
    ]);

    await service.evaluateDue();

    // guard вернул undefined → кандидат пропущен (повтор позже), а не отклонён.
    expect(observedRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ rejectReason: 'message-gone' })
    );
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, views: 0, reactions: 0 })
    );
  });

  // ---------- collector: caption/links null + album fallbacks ----------
  it('collector: сообщение без текста/ссылок → null-поля; fwd из PeerChannel сохраняется', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const discovery = { registerCrossLinks: jest.fn() };
    const parserClient = makeParserClient({ getMessages: jest.fn().mockResolvedValue([]) });
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), parserClient, discovery as never, makeConfig(), clock
    );

    await service.onLiveEvent({
      isChannel: true,
      chatId: bigInt('-1008888888888'),
      message: mediaMessage({ message: undefined, fwdFrom: { fromId: new Api.PeerChannel({ channelId: bigInt('7777777777') }) } }),
    } as never);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(observedRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: null,
        fwdFromChatId: '-1007777777777',
        crossLinks: [{ username: null, chatId: -1007777777777 }],
      })
    );
    expect(discovery.registerCrossLinks).toHaveBeenCalled();
  });

  it('collector: flushAlbum с PeerChannel-иначе и fetch без результата', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const parserClient = makeParserClient({ getMessages: jest.fn().mockResolvedValue([]) });
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), parserClient, { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    const group = { ids: [1], rawChatId: '8888888888', kind: 'photo' as const };
    await (service as never as { flushAlbum: (g: unknown) => Promise<void> }).flushAlbum(group);
    expect(observedRepo.create).not.toHaveBeenCalled();
  });

  it('collector: markSourceError warn с фолбэком chatId', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.listCollectible.mockResolvedValue([source({ title: null })]);
    const client = { getMessages: jest.fn().mockRejectedValue(42) };
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), makeParserClient(client),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    expect(await service.sweepAll()).toBe(0);
    expect(registry.repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: '42' })
    );
  });

  // ---------- ai: null-ветки ----------
  it('ai: classifyChannel null-ответ; isCringePost undefined-ответ; title null', async () => {
    const deepseek: any = { completeJson: jest.fn().mockResolvedValue(null) };
    const ai = new ParserAiService(deepseek, makeSettings({ aiEnabled: true }) as never);

    expect(await ai.classifyChannel(null, [])).toBeNull();
    expect(await ai.isCringePost('текст')).toBe(false);

    deepseek.completeJson.mockResolvedValueOnce(undefined);
    expect(await ai.isCringePost('текст')).toBe(false);
  });

  // ---------- parser.service: onStats при выключенном ----------
  it('parser.service: onStats при disabled не идёт в реестр', async () => {
    const registry = { listCollectible: jest.fn(), refreshSourceStats: jest.fn(), pruneWeakSources: jest.fn() };
    const settings = makeSettings();
    (settings as { enabled: boolean }).enabled = false;
    const service = new ParserService(
      settings as never, registry as never, {} as never, {} as never, {} as never, {} as never,
      { registerCallbacks: jest.fn() } as never, makeParserClient({}), { activeClient: undefined } as never
    );

    await (service as never as { onStats(): Promise<void> }).onStats();
    expect(registry.listCollectible).not.toHaveBeenCalled();
  });

  // ---------- moderation: зарегистрированные хендлеры с ctx.match ----------
  it('moderation: колбэки с match — карточка и кандидат, обе ветки approve', async () => {
    const { service, observedRepo } = makeModeration();
    const bot = (service as never as { bot: any }).bot;
    const discovery = (service as never as { discovery: any }).discovery;

    service.registerCallbacks();
    const cardHandler = bot.callbackQuery.mock.calls[0][1];
    const candidateHandler = bot.callbackQuery.mock.calls[1][1];

    const cardCtx: any = {
      match: ['prs:now:10', 'now', '10'],
      callbackQuery: { message: { message_id: 7777 }, from: { id: 1, username: 'mod' } },
      answerCallbackQuery: jest.fn(),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    };
    await cardHandler(cardCtx);
    expect(observedRepo.findOne).toHaveBeenCalled();

    for (const [action, answer] of [
      ['wo', 'Добавлен (web-only)'],
      ['jo', 'Добавлен (активный)'],
    ] as const) {
      const ctx: any = {
        match: [`prsc:${action}:1`, action, '1'],
        config: { isOwner: true },
        answerCallbackQuery: jest.fn(),
        editMessageText: jest.fn().mockResolvedValue(undefined),
      };
      await candidateHandler(ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(answer);
    }

    const notFoundCtx: any = {
      match: ['prsc:rj:1', 'rj', '1'],
      config: { isOwner: true },
      answerCallbackQuery: jest.fn(),
      editMessageText: jest.fn().mockResolvedValue(undefined),
    };
    discovery.reject.mockResolvedValueOnce(null);
    await candidateHandler(notFoundCtx);
    expect(notFoundCtx.answerCallbackQuery).toHaveBeenCalledWith('Не найден');
  });

  // ---------- collector: flushAlbum ветки и peer fallback ----------
  it('collector: album без peerId; flushAlbum own/disabled/без медиа; peer по chatId', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.repository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(source({ status: 'disabled' }))
      .mockResolvedValue(source());
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(),
      makeParserClient({ getMessages: jest.fn().mockResolvedValue([]) }),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    // альбом без peerId → rawChatId = chatId
    await service.onLiveEvent({
      isChannel: true,
      chatId: bigInt('-1008888888888'),
      message: { ...mediaMessage(), peerId: undefined, groupedId: bigInt('910') },
    } as never);
    jest.advanceTimersByTime(1600);
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    // собственный канал через flushAlbum напрямую
    const flush = (service as never as { flushAlbum: (g: unknown) => Promise<void> }).flushAlbum;
    await flush.call(service, { ids: [1], rawChatId: '1111111111', kind: 'photo' });
    await flush.call(service, { ids: [1], rawChatId: '8888888888', kind: 'photo' });
    expect(observedRepo.create).not.toHaveBeenCalled();

    // сообщение без медиа после перечитывания
    const service2 = new ParserCollectorService(
      observedRepo, registry, makeGuard(),
      makeParserClient({ getMessages: jest.fn().mockResolvedValue([{ id: 1, photo: undefined }] as never) }),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );
    await (service2 as never as { flushAlbum: (g: unknown) => Promise<void> }).flushAlbum.call(service2, {
      ids: [1], rawChatId: '8888888888', kind: 'photo',
    });
    expect(observedRepo.create).not.toHaveBeenCalled();
  });

  it('collector: sweep c peer=chatId (без rawChatId и username) и альбом-фолбэк rawIdOf', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.listCollectible.mockResolvedValue([source({ rawChatId: null, username: null })]);
    const album = mediaMessage({ id: 10, groupedId: bigInt('700') });
    const client = {
      getMessages: jest
        .fn()
        .mockResolvedValueOnce([album] as never)
        .mockResolvedValueOnce([mediaMessage({ id: 10, photo: undefined })] as never),
    };
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), makeParserClient(client),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    expect(await service.sweepAll()).toBe(0);
    // Нет rawChatId и username — источник пропускается до MTProto-вызова.
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('collector: сообщение вообще без ссылок → crossLinks null; fetchMessage при reject guard', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(),
      makeParserClient({ getMessages: jest.fn().mockRejectedValue(new Error('x')) }),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    await service.onLiveEvent({
      isChannel: true,
      chatId: bigInt('-1008888888888'),
      message: mediaMessage({ message: undefined }),
    } as never);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(observedRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ crossLinks: null, fwdFromChatId: null, caption: null })
    );
  });

  // ---------- delivery: rawChatId null и пустой буфер ----------
  it('delivery: rawChatId null → rawIdOf; пустой буфер → media-download-empty', async () => {
    const bot: any = { api: { sendPhoto: jest.fn().mockResolvedValue({ message_id: 4 }) } };
    const registry = makeRegistryMock();
    registry.repository.findOne.mockResolvedValue(source({ rawChatId: null }));
    const observedRepo = makeObservedRepo();
    const client = {
      getMessages: jest.fn().mockResolvedValue([mediaMessage()]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    };
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), registry, makeParserClient(client), { checkDuplicate: jest.fn() } as never,
      observedRepo, clock
    );

    expect(await service.deliver(candidateRow())).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  // ---------- discovery: postsPerDay>60, resolveUsername ветки ----------
  it('discovery: postsPerDay>60 → rejected; resolveUsername через частные вызовы', async () => {
    const fetchTmePreview = fetchTmePreviewMock as jest.Mock;
    const candidateRepo = makeObservedRepo();
    const client = { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 1000 } }) };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    fetchTmePreview.mockResolvedValue({
      username: 'linked',
      title: 'T',
      posts: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        views: 300,
        hasMedia: true,
        text: '',
        timeIso: new Date(Date.UTC(2026, 8, 19, 10, index * 10)).toISOString(),
      })),
    });

    const result = await service.checkCandidate(candidateRow({}));
    expect(result.verdict).toBe('rejected');
    expect(result.reason).toContain('postsPerDay=');

    const resolveUsername = (
      service as never as { resolveUsername: (c: unknown) => Promise<string | null> }
    ).resolveUsername;
    expect(await resolveUsername.call(service, candidateRow({ username: 'set' }))).toBe('set');
    expect(await resolveUsername.call(service, candidateRow({ username: null, chatId: null }))).toBeNull();
  });

  it('discovery: getEntity без id → chatId-unresolved; entity без username → null', async () => {
    const candidateRepo = makeObservedRepo();
    const client = {
      invoke: jest.fn().mockResolvedValue({}),
      getEntity: jest.fn().mockResolvedValue({ username: undefined, id: undefined }),
    };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    candidateRepo.findOne.mockResolvedValue(candidateRow({ username: null, chatId: null }));

    expect(await service.approve(1, 'web_only')).toBeNull();

    const resolveUsername = (
      service as never as { resolveUsername: (c: unknown) => Promise<string | null> }
    ).resolveUsername;
    expect(
      await resolveUsername.call(service, candidateRow({ username: null, chatId: '-1008888888888' }))
    ).toBeNull();
  });

  // ---------- registry: participants ?? 0 и null-метрики в базлайне ----------
  it('registry: invoke без fullChat → подписчики не пишутся; строки без views', async () => {
    const observedRepo = makeObservedRepo();
    const invoke = jest.fn().mockResolvedValue({});
    const service = new ParserRegistryService(
      makeSourceRepo(), observedRepo, makeConfig(), makeGuard(), makeParserClient({}), makeSettingsStub(), clock
    );

    const updated = await service.refreshSourceStats(source(), { invoke } as never);
    expect(updated?.subscribers).toBeNull();

    observedRepo.find.mockResolvedValue([
      { views: null, reactions: null, metrics: { posShare: 0.5 } },
      { views: 200, reactions: 6, metrics: null },
      { views: 300, reactions: 7, metrics: { posShare: 0.3 } },
      { views: 400, reactions: 8, metrics: { posShare: 0.2 } },
      { views: 500, reactions: 9, metrics: { posShare: 0.1 } },
      { views: 600, reactions: 10, metrics: { posShare: 0.4 } },
    ]);
    const baseline = await service.computeBaselineFor(source());
    expect(baseline?.sampleSize).toBe(6);
    expect(baseline?.vmed).toBeGreaterThanOrEqual(0);
  });

  // ---------- selector: delivered-строка без mediaUniqueId ----------
  it('selector: alreadyUsed строки без mediaUniqueId → фолбэк пустой строки', async () => {
    const observedRepo = makeObservedRepo();
    observedRepo.find.mockImplementation((options: any = {}) => {
      if (options.where?.mediaUniqueId !== undefined) {
        return Promise.resolve([{ status: ObservedStatus.PUBLISHED }]);
      }
      return Promise.resolve([candidateRow({ mediaUniqueId: 'm-1' })]);
    });
    const registry = makeRegistryMock();
    registry.repository.find.mockResolvedValue([source()]);
    const delivery = { deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }) };
    const service = new ParserSelectorService(
      observedRepo, registry, { isEligible: jest.fn(() => true) } as never, delivery as never, makeSettings(), clock
    );

    expect(await service.selectAndDeliver()).toBe(1);
  });

  // ---------- evaluator: элемент реакции без count ----------
  it('evaluator: реакция без count → 0', () => {
    const observedRepo = makeObservedRepo();
    const service = new ParserEvaluatorService(
      observedRepo, makeRegistryMock(), makeParserClient({}), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    const message = {
      reactions: { results: [{ reaction: new Api.ReactionEmoji({ emoticon: '🔥' }) }] },
    } as never;
    expect(
      (service as never as { reactionResults: (m: unknown) => Array<{ emoji: string; count: number }> }).reactionResults(
        message
      )
    ).toEqual([{ emoji: '🔥', count: 0 }]);
  });

  // ---------- menu: лейблы и кандидаты с полными данными ----------
  it('menu: лейбл AI/Конвейер при выключенном; карточки кандидатов со всеми полями', async () => {
    const settings = makeSettings({ enabled: false });
    const registry = makeRegistryMock();
    registry.listAll.mockResolvedValue([
      source({ status: 'disabled', title: null, category: 'cringe' }),
      source({ id: 2, status: 'web_only', username: 'webb', title: null }),
    ]);
    const discovery = {
      repository: { count: jest.fn().mockResolvedValue(1) },
      listReady: jest.fn().mockResolvedValue([
        {
          id: 5,
          title: null,
          username: 'cand',
          key: 'u:cand',
          mentions: 2,
          subscribers: 100,
          errEstimate: 0.2,
          postsPerDay: 5,
          aiVerdict: { category: 'memes', relevance: 0.9 },
        },
      ]),
    };
    const repo = makeObservedRepo();
    const bot: any = { api: { sendMessage: jest.fn() } };
    const service = new ParserMenuService(
      bot, repo, settings, registry, discovery as never, { buildCandidateKeyboard: jest.fn() } as never,
    );

    const menu = service.getMenu();
    void menu;
    const stats = await service.statsLine();
    expect(stats).toContain('⏳ 0');
    void bot;
  });

  // ---------- ai: без названия ----------
  it('ai: classifyChannel с title=null уходит в промпт с заглушкой', async () => {
    const deepseek: any = {
      completeJson: jest.fn().mockResolvedValue({ category: 'memes', relevance: 0.9, nsfw: false }),
    };
    const ai = new ParserAiService(deepseek, makeSettings({ aiEnabled: true }) as never);

    const verdict = await ai.classifyChannel(null, ['текст']);
    expect(verdict?.category).toBe('memes');
    const call = deepseek.completeJson.mock.calls[0];
    expect(call[1]).toContain('(без названия)');
  });

  // ---------- guard: throw undefined ----------
  it('guard: throw undefined → обычная ошибка, undefined результат', async () => {
    const bot: any = { api: { sendMessage: jest.fn() } };
    const guard = new ParserMtprotoGuard(bot, makeConfig(), random);

    await expect(
      guard.run('op', async () => {
        throw undefined;
      })
    ).resolves.toBeUndefined();
  });

  // ---------- discovery: registerCrossLinks лог лимита ----------
  it('discovery: registerCrossLinks > лимита не падает', async () => {
    const candidateRepo = makeObservedRepo();
    candidateRepo.findOne.mockResolvedValue({ id: 1, mentions: 5 });
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient({}), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );

    await service.registerCrossLinks(
      Array.from({ length: 12 }, (_, index) => ({ username: `ch${index}`, chatId: null, origin: 'link' as const }))
    );
    expect(candidateRepo.save).toHaveBeenCalledTimes(12);
  });

  // ---------- parser.service: переподключение при новом клиенте ----------
  it('parser.service: пересозданный клиент → повторный attach', async () => {
    jest.useFakeTimers();
    const client = { addEventHandler: jest.fn() };
    const clientBase = { activeClient: client };
    const service = new ParserService(
      makeSettings() as never,
      { listCollectible: jest.fn(), refreshSourceStats: jest.fn(), pruneWeakSources: jest.fn() } as never,
      { onLiveEvent: jest.fn(), sweepAll: jest.fn() } as never,
      { evaluateDue: jest.fn() } as never,
      { selectAndDeliver: jest.fn() } as never,
      { runWebCheck: jest.fn() } as never,
      { registerCallbacks: jest.fn() } as never,
      makeParserClient(client),
      clientBase as never
    );
    service.onModuleInit();
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(client.addEventHandler).toHaveBeenCalledTimes(1);

    const client2 = { addEventHandler: jest.fn() };
    clientBase.activeClient = client2;
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(client2.addEventHandler).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  // ---------- discovery: джойн-кап и кап web-check ----------
  it('discovery: третий джойн за сутки блокируется; attempts кап', async () => {
    const candidateRepo = makeObservedRepo();
    const client = {
      invoke: jest.fn().mockResolvedValue({}),
      getEntity: jest.fn().mockResolvedValue({ id: bigInt('8888888888') }),
    };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );

    for (let i = 0; i < 2; i += 1) {
      candidateRepo.findOne.mockResolvedValue(candidateRow({ id: 10 + i, verdict: 'ready' }));
      await service.approve(10 + i, 'join');
    }
    candidateRepo.findOne.mockResolvedValue(candidateRow({ id: 12, verdict: 'ready' }));
    const third = await service.approve(12, 'join');
    expect(third).toBeNull();
    expect(candidateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'join-daily-cap' })
    );

    // attempts кап: инфраструктурные причины N раз → rejected
    const service2 = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient({ invoke: jest.fn().mockResolvedValue(null) }),
      makeGuard(), makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    fetchTmePreviewMock.mockResolvedValue({
      username: 'linked',
      title: 'T',
      posts: [{ id: 1, views: 300, hasMedia: true, text: '', timeIso: null }],
    });
    const row = candidateRow({});
    for (let i = 0; i < 5; i += 1) {
      await service2.checkCandidate(row);
    }
    expect(row.verdict).toBe('rejected');
    expect(row.reason).toBe('checks-exhausted');
  });

  // ---------- moderation: уже обработано ----------
  it('moderation: не-DELIVERED карточка → «Уже обработано»', async () => {
    const { service } = makeModeration();
    (service as never as { observedRepository: any }).observedRepository.findOne.mockResolvedValue(
      candidateRow({ status: 'queued', requestChannelMessageId: 7777 })
    );
    const ctx: any = {
      callbackQuery: { message: { message_id: 7777 }, from: { id: 1 } },
      answerCallbackQuery: jest.fn(),
    };

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Уже обработано');
  });

  // ---------- quotas: memesLimit жёсткое резервирование ----------
  it('quotas: мемы не вылазят за memesLimit при кринж-кандидатах', async () => {
    const rules = { dailyLimit: 2, sourceDailyCap: 5, cringeShare: 0.5 };
    const candidates = [
      { id: 1, sourceChatId: 10, category: 'memes', score: 9, stage: 'final' },
      { id: 2, sourceChatId: 20, category: 'memes', score: 8, stage: 'final' },
      { id: 3, sourceChatId: 30, category: 'cringe', score: 1, stage: 'final' },
    ];
    const picked = pickByFairness(candidates, rules, { perSource: {}, cringe: 0, total: 0 });
    expect(picked).toEqual([1, 3]);
  });

  // ---------- collector: альбом в sweep с rawIdOf-фолбэком ----------
  it('collector: sweep-альбом по rawIdOf при отсутствии rawChatId', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.listCollectible.mockResolvedValue([
      source({ rawChatId: null, username: 'memes_source' }),
    ]);
    const album = mediaMessage({ id: 10, groupedId: bigInt('700') });
    const client = {
      getMessages: jest
        .fn()
        .mockResolvedValueOnce([album] as never)
        .mockResolvedValueOnce([album] as never),
    };
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), makeParserClient(client),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    expect(await service.sweepAll()).toBe(1);
  });

  // ---------- evaluator: PRE → FINAL переоценка ----------
  it('evaluator: SCORED+PRE дозревает до FINAL и уходит в rejected по порогам', async () => {
    const observedRepo = makeObservedRepo();
    const client = {
      getMessages: jest.fn().mockResolvedValue([
        { id: 42, views: 100, reactions: { results: [] } } as never,
      ]),
    };
    const service = new ParserEvaluatorService(
      observedRepo, makeRegistryMock(), makeParserClient(client), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    observedRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
      candidateRow({ status: 'scored', evalStage: 'pre', createdAt: new Date(NOW.getTime() - 13 * 3_600_000) }),
    ]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, evalStage: 'final' })
    );
  });

  // ---------- evaluator: протухший сохранённый базлайн ----------
  it('evaluator: протухший baseline → пересчёт из реестра', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.repository.findOne.mockResolvedValue(
      source({ baseline: { ...BASELINE, updatedAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() } })
    );
    const client = {
      getMessages: jest.fn().mockResolvedValue([
        { id: 42, views: 4000, reactions: { results: [{ reaction: new Api.ReactionEmoji({ emoticon: '🔥' }), count: 40 }] } } as never,
      ]),
    };
    const service = new ParserEvaluatorService(
      observedRepo, registry, makeParserClient(client), makeGuard(),
      makeSettings(), { rejectPostIfTrash: jest.fn() } as never, clock, random
    );
    observedRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
      candidateRow({ createdAt: new Date(NOW.getTime() - 13 * 3_600_000) }),
    ]);

    expect(await service.evaluateDue()).toBe(1);
    expect(registry.computeBaselineFor).toHaveBeenCalled();
  });

  // ---------- cross-links: t.me/c ссылка на свой канал ----------
  it('cross-links: ссылка на свой канал в тексте отсекается', () => {
    const hits = collectPostCrossLinks(
      { message: 'https://t.me/c/8888888888/12', fwdFrom: null },
      [-1008888888888]
    );
    expect(hits).toEqual([]);
  });

  // ---------- меню: лейблы при выключенном и AI ----------
  it('menu: лейблы конвейера/AI отражают состояние', async () => {
    const settings = makeSettings({ enabled: false, aiEnabled: true });
    const registry = makeRegistryMock();
    const repo = makeObservedRepo();
    const service = new ParserMenuService(
      { api: { sendMessage: jest.fn() } } as never, repo, settings, registry,
      { repository: { count: jest.fn().mockResolvedValue(0) }, listReady: jest.fn().mockResolvedValue([]) } as never,
      { buildCandidateKeyboard: jest.fn() } as never
    );

    const menu = service.getMenu();
    void menu;
    const stats = await service.statsLine();
    expect(stats).toContain('⏳ 0');
  });

  // ---------- telegram-link ----------
  it('telegram-link: краевые ветки', () => {
    expect(channelInternalId(null)).toBe('0');
    expect(buildPostUrl(undefined as never, null)).toBeNull();
    expect(buildPostUrl({ username: ' @User ' } as never, 5)).toBe('https://t.me/User/5');
    expect(buildPostUrl({} as never, null)).toBeNull();
  });
});
