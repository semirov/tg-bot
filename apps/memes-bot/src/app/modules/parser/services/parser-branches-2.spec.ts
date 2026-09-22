import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ObservedStatus } from '../constants/parser.constants';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { ParserSelectorService } from './parser-selector.service';
import { ParserEvaluatorService } from './parser-evaluator.service';
import { ParserCollectorService } from './parser-collector.service';
import { ParserService } from './parser.service';
import { channelInternalId, buildPostUrl } from '../../../shared/publication/telegram-link';

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
  perceptualHash: null,
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
  listAll: jest.fn().mockResolvedValue([]),
  countCollectible: jest.fn().mockResolvedValue(0),
  isOwnChannel: jest.fn((chatId: number) => chatId === -1001111111111),
  computeBaselineFor: jest.fn().mockResolvedValue({ vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 5 }),
  addSource: jest.fn().mockResolvedValue({ id: 1 }),
  markSourceTaken: jest.fn().mockResolvedValue(undefined),
  markSourceIgnored: jest.fn().mockResolvedValue(undefined),
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
    maxSources: 20,
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

const BASELINE = {
  vmed: 1000,
  rmed: 10,
  p90: 4000,
  posShare: 0.8,
  sampleSize: 10,
  updatedAt: NOW.toISOString(),
};

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

const fetchTmePreviewMock = jest.requireMock('../domain/tme-preview').fetchTmePreview as jest.Mock;

describe('parser branches round 2', () => {
  // ---------- delivery ----------
  it('delivery: видео дубль опубликованного по обложке', async () => {
    const video = new Api.Document({
      id: bigInt('777'),
      accessHash: bigInt('1'),
      fileReference: Buffer.from([]),
      date: 1000,
      attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 640, h: 640 })],
      mimeType: 'video/mp4',
      size: bigInt('1000'),
      dcId: 2,
      thumbs: [new Api.PhotoSize({ type: 'm', w: 1, h: 1, size: 1 })],
    });
    const dedup = {
      checkDuplicateSameLength: jest.fn().mockResolvedValue([{ distance: 0.9 }]),
      calculateHashDistance: jest.fn(() => 0),
    };
    const bot: any = { api: { sendVideo: jest.fn(), deleteMessage: jest.fn(), editMessageCaption: jest.fn() } };
    const client = {
      getMessages: jest.fn().mockResolvedValue([{ id: 42, video, views: 4000 } as never]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1, 2])),
    };
    const observedRepo = makeObservedRepo();
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient(client), dedup as never, observedRepo, clock
    );

    const row = candidateRow({ mediaKind: 'video' });
    const result = await service.deliver(row);

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.DUPLICATE });
    expect(row.rejectReason).toBe('published-duplicate');
    expect(bot.api.sendVideo).not.toHaveBeenCalled();
  });

  it('delivery: checkDuplicate undefined → доставляем', async () => {
    const dedup = {
      checkDuplicateSameLength: jest.fn().mockResolvedValue(undefined),
      calculateHashDistance: jest.fn(),
    };
    const bot: any = { api: { sendPhoto: jest.fn().mockResolvedValue({ message_id: 2 }) } };
    const client = {
      getMessages: jest.fn().mockResolvedValue([mediaMessage()]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1])),
    };
    const service = new ParserDeliveryService(
      bot, makeConfig(), makeGuard(), makeRegistryMock(), makeParserClient(client), dedup as never, makeObservedRepo(), clock
    );

    expect(await service.deliver(candidateRow())).toMatchObject({ ok: true });
  });

  // ---------- discovery ----------
  it('discovery: postsPerDay>60 → rejected; resolveUsername ветки', async () => {
    const candidateRepo = makeObservedRepo();
    const client = { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 1000 } }) };
    const service = new ParserDiscoveryService(
      candidateRepo, makeSourceRepo(), makeParserClient(client), makeGuard(),
      makeRegistryMock(), makeSettings(), { classifyChannel: jest.fn(), rejectPostIfTrash: jest.fn() } as never, clock
    );
    fetchTmePreviewMock.mockResolvedValue({
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

    const result = await service.checkCandidate(candidateRow({ chatId: '-1008888888888' }));
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

  // ---------- selector ----------
  it('selector: строки без score/mediaUniqueId не роняют добор', async () => {
    const observedRepo = makeObservedRepo();
    observedRepo.find.mockResolvedValue([
      candidateRow({ id: 1, score: undefined, mediaUniqueId: null }),
      candidateRow({ id: 2, status: 'scored', mediaUniqueId: 'm-2' }),
    ]);
    const registry = makeRegistryMock();
    registry.repository.find.mockResolvedValue([source()]);
    const delivery = { deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }) };
    const service = new ParserSelectorService(
      observedRepo, registry, delivery as never, makeSettings(), makeConfig(),
      { api: { deleteMessage: jest.fn() } } as never, clock
    );
    (service as never as { pace: unknown }).pace = jest.fn().mockResolvedValue(undefined);

    expect(await service.dumpMore()).toBe(2);
  });

  // ---------- evaluator ----------
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

  it('evaluator: реакция без count → 0', () => {
    const service = new ParserEvaluatorService(
      makeObservedRepo(), makeRegistryMock(), makeParserClient({}), makeGuard(),
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

  // ---------- collector ----------
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

  it('collector: flushAlbum с own/disabled/без медиа', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    const parserClient = makeParserClient({ getMessages: jest.fn().mockResolvedValue([]) });
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), parserClient, { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    const flush = (service as never as { flushAlbum: (g: unknown) => Promise<void> }).flushAlbum;
    await flush.call(service, { ids: [1], rawChatId: '1111111111', kind: 'photo' });
    registry.repository.findOne.mockResolvedValueOnce(source({ status: 'disabled' }));
    await flush.call(service, { ids: [1], rawChatId: '8888888888', kind: 'photo' });
    expect(observedRepo.create).not.toHaveBeenCalled();

    const service2 = new ParserCollectorService(
      observedRepo, registry, makeGuard(),
      makeParserClient({ getMessages: jest.fn().mockResolvedValue([{ id: 1, photo: undefined }] as never) }),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );
    registry.repository.findOne.mockResolvedValue(source());
    await (service2 as never as { flushAlbum: (g: unknown) => Promise<void> }).flushAlbum.call(service2, {
      ids: [1], rawChatId: '8888888888', kind: 'photo',
    });
    expect(observedRepo.create).not.toHaveBeenCalled();
  });

  it('collector: sweep-альбом по rawIdOf при отсутствии rawChatId', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistryMock();
    registry.listCollectible.mockResolvedValue([source({ rawChatId: null, username: 'memes_source' })]);
    const album = mediaMessage({ id: 10, groupedId: bigInt('700') });
    const client = {
      getMessages: jest.fn().mockResolvedValueOnce([album] as never).mockResolvedValueOnce([album] as never),
    };
    const service = new ParserCollectorService(
      observedRepo, registry, makeGuard(), makeParserClient(client),
      { registerCrossLinks: jest.fn() } as never, makeConfig(), clock
    );

    expect(await service.sweepAll()).toBe(1);
  });

  it('collector: сообщение вообще без ссылок → crossLinks null', async () => {
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

  // ---------- parser.service ----------
  it('parser.service: onStats при disabled не идёт в реестр', async () => {
    const registry = { listCollectible: jest.fn(), refreshSourceStats: jest.fn(), refreshCooldowns: jest.fn() };
    const settings = makeSettings();
    (settings as { enabled: boolean }).enabled = false;
    const service = new ParserService(
      settings as never, registry as never, {} as never, {} as never, {} as never, {} as never,
      { registerCallbacks: jest.fn() } as never, makeParserClient({}),
      { activeClient: undefined } as never,
      { callbackQuery: jest.fn(), on: jest.fn(), api: {} } as never,
      makeConfig()
    );

    await (service as never as { onStats(): Promise<void> }).onStats();
    expect(registry.listCollectible).not.toHaveBeenCalled();
  });

  // ---------- telegram-link ----------
  it('telegram-link: краевые ветки', () => {
    expect(channelInternalId(null)).toBe('0');
    expect(buildPostUrl(undefined as never, null)).toBeNull();
    expect(buildPostUrl({ username: ' @User ' } as never, 5)).toBe('https://t.me/User/5');
    expect(buildPostUrl({} as never, null)).toBeNull();
  });
});
