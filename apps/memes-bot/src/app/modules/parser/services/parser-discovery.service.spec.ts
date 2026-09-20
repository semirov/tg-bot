import * as bigInt from 'big-integer';
import { CandidateOrigin, CandidateVerdict } from '../constants/parser.constants';
import { ParserDiscoveryService } from './parser-discovery.service';
import { fetchTmePreview } from '../domain/tme-preview';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

jest.mock('../domain/tme-preview', () => {
  const actual = jest.requireActual('../domain/tme-preview') as Record<string, unknown>;
  return { ...actual, fetchTmePreview: jest.fn() };
});

const NOW = new Date('2026-09-19T12:00:00Z');

const candidate = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  key: 'u:linked',
  username: 'linked',
  chatId: null,
  title: null,
  origin: CandidateOrigin.CROSS_LINK,
  mentions: 1,
  subscribers: null,
  errEstimate: null,
  postsPerDay: null,
  aiVerdict: null,
  verdict: CandidateVerdict.PENDING,
  attempts: 0,
  reason: null,
  checkedAt: null,
  ...overrides,
});

const preview = (views: number[], withTitle = 'Канал') => ({
  username: 'linked',
  title: withTitle,
  posts: views.map((count, index) => ({
    id: 100 + index,
    views: count,
    hasMedia: true,
    text: `текст ${index}`,
    timeIso: new Date(Date.UTC(2026, 8, 19, 10 - (views.length - index))).toISOString(),
  })),
});

const makeCandidateRepo = (): any => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((value) => ({ ...value })),
  save: jest.fn().mockImplementation(async (value) => value),
  count: jest.fn().mockResolvedValue(0),
});

const makeSourceRepo = (): any => ({
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeRegistry = (): any => ({
  addSource: jest.fn().mockResolvedValue({ id: 1 }),
});

const makeParserClient = (client: Record<string, unknown> = {}): any => ({
  client: jest.fn(() => client),
});

const makeGuard = (): any => ({
  run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()),
  pace: jest.fn().mockResolvedValue(undefined),
});

const makeSettings = (overrides: Record<string, unknown> = {}): any => ({
  current: { errMin: 0.15, aiEnabled: false, aiRelevanceMin: 0.6, ...overrides },
  enabled: true,
});

const makeAi = (): any => ({
  classifyChannel: jest.fn().mockResolvedValue({ category: 'memes', relevance: 0.9, nsfw: false }),
});

const makeClock = (): any => ({ now: jest.fn(() => NOW) });

const setup = (overrides: { client?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) => {
  const candidateRepo = makeCandidateRepo();
  const sourceRepo = makeSourceRepo();
  const registry = makeRegistry();
  const ai = makeAi();
  const client = overrides.client ?? {};
  const service = new ParserDiscoveryService(
    candidateRepo,
    sourceRepo,
    makeParserClient(client),
    makeGuard(),
    registry,
    makeSettings(overrides.settings ?? {}),
    ai,
    makeClock()
  );
  return { service, candidateRepo, sourceRepo, registry, ai, client };
};

describe('ParserDiscoveryService', () => {
  beforeEach(() => {
    (fetchTmePreview as jest.Mock).mockReset();
  });

  describe('registerCrossLinks', () => {
    it('создаёт кандидата по username и по chatId', async () => {
      const { service, candidateRepo } = setup();

      await service.registerCrossLinks([
        { username: 'linked', chatId: null, origin: 'link' },
        { username: null, chatId: -1008888888888, origin: 'fwd' },
      ]);

      expect(candidateRepo.create).toHaveBeenCalledTimes(2);
      expect(candidateRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'u:linked', username: 'linked', mentions: 1 })
      );
      expect(candidateRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'c:-1008888888888', chatId: '-1008888888888', origin: CandidateOrigin.CROSS_FWD })
      );
    });

    it('существующий кандидат → mentions++', async () => {
      const { service, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(candidate({ mentions: 3 }));

      await service.registerCrossLinks([{ username: 'linked', chatId: null, origin: 'link' }]);

      expect(candidateRepo.create).not.toHaveBeenCalled();
      expect(candidateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ mentions: 4 }));
    });

    it('уже в реестре → кандидата нет', async () => {
      const { service, candidateRepo } = setup();
      (service as never as { sourceRepository: any }).sourceRepository.findOne.mockResolvedValue({
        id: 9,
      });

      await service.registerCrossLinks([{ username: 'linked', chatId: null, origin: 'link' }]);

      expect(candidateRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('checkCandidate', () => {
    it('гейт пройден → READY', async () => {
      const { service, candidateRepo } = setup({ client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) } });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));

      const result = await service.checkCandidate(candidate());

      expect(result.verdict).toBe(CandidateVerdict.READY);
      expect(result.subscribers).toBe(10000);
      expect(result.errEstimate).toBeCloseTo(3000 / 10000);
      expect(result.postsPerDay).not.toBeNull();
      expect(candidateRepo.save).toHaveBeenCalled();
    });

    it('ERR ниже порога → REJECTED', async () => {
      const { service } = setup({ client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10_000_000 } }) } });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([100, 200, 300]));

      const result = await service.checkCandidate(candidate());

      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toContain('err<');
    });

    it('web-preview пуст → причина', async () => {
      const { service } = setup();
      (fetchTmePreview as jest.Mock).mockResolvedValue(null);

      const result = await service.checkCandidate(candidate());

      expect(result.verdict).toBe(CandidateVerdict.PENDING);
      expect(result.reason).toBe('web-preview-empty');
    });

    it('AI-фильтр: нерелевантный канал → REJECTED', async () => {
      const { service, ai } = setup({
        settings: { aiEnabled: true },
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) },
      });
      ai.classifyChannel.mockResolvedValue({ category: 'news', relevance: 0.2, nsfw: false });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));

      const result = await service.checkCandidate(candidate());

      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toContain('ai:relevance<');
    });

    it('username не резолвится → причина и без вердикта', async () => {
      const { service } = setup({
        client: { getEntity: jest.fn().mockResolvedValue(undefined) },
      });
      const result = await service.checkCandidate(candidate({ username: null, chatId: '-1008888888888' }));

      expect(result.reason).toBe('username-unresolved');
      expect(fetchTmePreview).not.toHaveBeenCalled();
    });
  });

  describe('runWebCheck', () => {
    it('нет кандидатов → 0', async () => {
      const { service } = setup();
      expect(await service.runWebCheck()).toBe(0);
    });

    it('проверяет пачку кандидатов', async () => {
      const { service, candidateRepo, client } = setup({
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) },
      });
      candidateRepo.find.mockResolvedValue([candidate(), candidate({ id: 2, key: 'u:other', username: 'other' })]);
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));

      const checked = await service.runWebCheck();

      expect(checked).toBe(2);
      expect(client.invoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('approve', () => {
    it('web_only: добавляет источник и помечает кандидата', async () => {
      const { service, registry, candidateRepo, client } = setup({
        client: { getEntity: jest.fn().mockResolvedValue({ id: bigInt('8888888888') }) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY }));

      const result = await service.approve(1, 'web_only');

      expect(result?.verdict).toBe(CandidateVerdict.APPROVED);
      expect(registry.addSource).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: -1008888888888, status: 'web_only' })
      );
      void client;
      void bigInt;
    });

    it('reject ставит вердикт', async () => {
      const { service, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY }));

      const result = await service.reject(1);

      expect(result?.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result?.reason).toBe('owner-rejected');
    });

    it('approve: username не резолвится → null', async () => {
      const { service, client } = setup({
        client: { getEntity: jest.fn().mockResolvedValue(undefined) },
      });

      const result = await service.approve(1, 'join');
      expect(result).toBeNull();
    });

    it('approve: джойн не удался → null и причина', async () => {
      const { service, candidateRepo, client } = setup({
        client: { invoke: jest.fn().mockResolvedValue(null) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY }));

      const result = await service.approve(1, 'join');
      expect(result).toBeNull();
      expect(candidateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ reason: 'join-failed' }));
      void client;
    });

    it('approve: chatId не резолвится → null', async () => {
      const { service, candidateRepo, client } = setup({
        client: { invoke: jest.fn().mockResolvedValue({}), getEntity: jest.fn().mockResolvedValue({}) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY }));

      const result = await service.approve(1, 'join');
      expect(result).toBeNull();
      expect(candidateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'chatId-unresolved' })
      );
    });

    it('approve: нет кандидата → null', async () => {
      const { service } = setup();
      expect(await service.approve(99, 'join')).toBeNull();
    });
  });
});
