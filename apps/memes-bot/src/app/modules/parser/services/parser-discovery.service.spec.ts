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
  isExcluded: jest.fn().mockResolvedValue(false),
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

    it('hit без username/chatId пропускается', async () => {
      const { service, candidateRepo } = setup();
      await service.registerCrossLinks([{ username: null, chatId: null, origin: 'link' }]);
      expect(candidateRepo.create).not.toHaveBeenCalled();
    });

    it('существующий кандидат → mentions++', async () => {
      const { service, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(candidate({ mentions: 3 }));

      await service.registerCrossLinks([{ username: 'linked', chatId: null, origin: 'link' }]);

      expect(candidateRepo.create).not.toHaveBeenCalled();
      expect(candidateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ mentions: 4 }));
    });

    it('уже в реестре по username → кандидата нет', async () => {
      const { service, candidateRepo, sourceRepo } = setup();
      sourceRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve(where.username ? { id: 9 } : null)
      );

      await service.registerCrossLinks([{ username: 'linked', chatId: null, origin: 'link' }]);

      expect(candidateRepo.create).not.toHaveBeenCalled();
    });

    it('уже в реестре по chatId → кандидата нет', async () => {
      const { service, candidateRepo, sourceRepo } = setup();
      sourceRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve(where.username ? null : { id: 6 })
      );

      await service.registerCrossLinks([{ username: null, chatId: -100777, origin: 'fwd' }]);

      expect(candidateRepo.create).not.toHaveBeenCalled();
    });

    it('больше лимита новых кандидатов за прогон', async () => {
      const { service, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(null);

      await service.registerCrossLinks(
        Array.from({ length: 12 }, (_, index) => ({ username: `ch${index}`, chatId: null, origin: 'link' as const }))
      );

      expect(candidateRepo.create).toHaveBeenCalledTimes(12);
    });
  });

  describe('checkCandidate', () => {
    it('гейт пройден → READY и авто-approve (web_only)', async () => {
      const { service, candidateRepo, registry } = setup({
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) },
      });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));
      const row = candidate({ chatId: '-1008888888888' });
      candidateRepo.findOne.mockResolvedValue(row);

      const result = await service.checkCandidate(row);

      expect(result.verdict).toBe(CandidateVerdict.APPROVED);
      expect(result.subscribers).toBe(10000);
      expect(result.errEstimate).toBeCloseTo(3000 / 10000);
      expect(result.postsPerDay).not.toBeNull();
      expect(registry.addSource).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: -1008888888888, status: 'web_only' })
      );
    });

    it('ERR ниже порога → REJECTED', async () => {
      const { service, candidateRepo } = setup({
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10_000_000 } }) },
      });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([100, 200, 300]));
      const row = candidate({ chatId: '-1008888888888' });
      candidateRepo.findOne.mockResolvedValue(row);

      const result = await service.checkCandidate(row);

      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toContain('err<');
    });

    it('web-preview пуст → причина', async () => {
      const { service, candidateRepo } = setup();
      (fetchTmePreview as jest.Mock).mockResolvedValue(null);

      const result = await service.checkCandidate(candidate());

      expect(result.verdict).toBe(CandidateVerdict.PENDING);
      expect(result.reason).toBe('web-preview-empty');
      expect(candidateRepo.save).toHaveBeenCalled();
    });

    it('AI-фильтр: нерелевантный канал → REJECTED', async () => {
      const { service, candidateRepo, ai } = setup({
        settings: { aiEnabled: true },
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) },
      });
      ai.classifyChannel.mockResolvedValue({ category: 'news', relevance: 0.2, nsfw: false });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));
      const row = candidate({ chatId: '-1008888888888' });
      candidateRepo.findOne.mockResolvedValue(row);

      const result = await service.checkCandidate(row);

      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toContain('ai:relevance<');
    });

    it('AI-фильтр: nsfw отбрасывает', async () => {
      const { service, ai } = setup({
        settings: { aiEnabled: true },
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) },
      });
      ai.classifyChannel.mockResolvedValue({ category: 'memes', relevance: 0.9, nsfw: true });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));

      const result = await service.checkCandidate(candidate({ chatId: '-1008888888888' }));

      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toBe('ai:nsfw');
    });

    it('postsPerDay вне окна → REJECTED', async () => {
      const { service } = setup({
        client: { invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }) },
      });
      (fetchTmePreview as jest.Mock).mockResolvedValue({
        username: 'linked',
        title: 'T',
        posts: Array.from({ length: 10 }, (_, index) => ({
          id: index,
          views: 3000,
          hasMedia: true,
          text: '',
          timeIso: new Date(Date.UTC(2026, 8, 19, 10, index * 1)).toISOString(),
        })),
      });

      const result = await service.checkCandidate(candidate({ chatId: '-1008888888888' }));

      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toContain('postsPerDay=');
    });

    it('нет данных о ERR → PENDING err-unavailable', async () => {
      const { service } = setup({ client: { invoke: jest.fn().mockResolvedValue({}) } });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([0]));

      const result = await service.checkCandidate(candidate({ chatId: '-1008888888888' }));

      expect(result.errEstimate).toBeNull();
      expect(result.verdict).toBe(CandidateVerdict.PENDING);
      expect(result.reason).toBe('err-unavailable');
    });

    it('username не резолвится → причина и без вердикта', async () => {
      const { service } = setup({
        client: { getEntity: jest.fn().mockResolvedValue(undefined) },
      });
      const result = await service.checkCandidate(candidate({ username: null, chatId: '-1008888888888' }));

      expect(result.reason).toBe('username-unresolved');
      expect(fetchTmePreview).not.toHaveBeenCalled();
    });

    it('инфраструктурная причина гейта с капом попыток → REJECTED', async () => {
      const { service } = setup({ client: { invoke: jest.fn().mockResolvedValue({ fullChat: {} }) } });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([100, 200, 300]));
      const row = candidate({ chatId: '-1008888888888', attempts: 4 });

      await service.checkCandidate(row);

      expect(row.verdict).toBe(CandidateVerdict.REJECTED);
      expect(row.reason).toBe('checks-exhausted');
    });

    it('resolveUsername без клиента → null', async () => {
      const { service } = setup();
      (service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);
      const result = await (
        service as never as { resolveUsername: (c: unknown) => Promise<string | null> }
      ).resolveUsername(candidate({ username: null, chatId: '-1008888888888' }));
      expect(result).toBeNull();
    });

    it('resolveUsername: getEntity вернул null → null', async () => {
      const { service } = setup({ client: { getEntity: jest.fn().mockResolvedValue(null) } });
      const result = await (
        service as never as { resolveUsername: (c: unknown) => Promise<string | null> }
      ).resolveUsername(candidate({ username: null, chatId: '-1008888888888' }));
      expect(result).toBeNull();
    });

    it('invokeGetFullChannel без клиента → null', async () => {
      const { service } = setup();
      (service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);
      const result = await (
        service as never as { invokeGetFullChannel: (u: string) => Promise<unknown> }
      ).invokeGetFullChannel('x');
      expect(result).toBeNull();
    });

    it('username-unresolved: кап попыток → REJECTED checks-exhausted', async () => {
      const { service } = setup({ client: { getEntity: jest.fn().mockResolvedValue(undefined) } });
      const row = candidate({ username: null, chatId: '-1008888888888', attempts: 4 });

      const result = await service.checkCandidate(row);

      expect(result.attempts).toBe(5);
      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toBe('checks-exhausted');
    });

    it('web-preview-empty: кап попыток → REJECTED checks-exhausted', async () => {
      const { service } = setup();
      (fetchTmePreview as jest.Mock).mockResolvedValue(null);
      const row = candidate({ attempts: 4 });

      const result = await service.checkCandidate(row);

      expect(result.attempts).toBe(5);
      expect(result.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result.reason).toBe('checks-exhausted');
    });

    it('getFullChannel недоступен → PENDING subscriber-check-failed, кап → REJECTED', async () => {
      const { service } = setup({ client: { invoke: jest.fn().mockResolvedValue(null) } });
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));
      const row = candidate({ chatId: '-1008888888888' });

      const first = await service.checkCandidate(row);
      expect(first.verdict).toBe(CandidateVerdict.PENDING);
      expect(first.reason).toBe('subscriber-check-failed');

      row.attempts = 4;
      await service.checkCandidate(row);
      expect(row.verdict).toBe(CandidateVerdict.REJECTED);
      expect(row.reason).toBe('checks-exhausted');
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
      candidateRepo.find.mockResolvedValue([
        candidate({ chatId: '-1001' }),
        candidate({ id: 2, key: 'u:other', username: 'other', chatId: '-1002' }),
      ]);
      candidateRepo.findOne.mockImplementation(async ({ where }: any) =>
        where.id === 2
          ? candidate({ id: 2, key: 'u:other', username: 'other', chatId: '-1002' })
          : candidate({ chatId: '-1001' })
      );
      (fetchTmePreview as jest.Mock).mockResolvedValue(preview([3000, 2000, 4000]));

      const checked = await service.runWebCheck();

      expect(checked).toBe(2);
      expect(client.invoke).toHaveBeenCalledTimes(2);
    });

    it('ошибка проверки кандидата не роняет прогон', async () => {
      const { service, candidateRepo } = setup();
      candidateRepo.find.mockResolvedValue([candidate()]);
      (fetchTmePreview as jest.Mock).mockRejectedValue(new Error('boom'));

      expect(await service.runWebCheck()).toBe(0);
    });
  });

  describe('approve', () => {
    it('web_only: добавляет источник и помечает кандидата', async () => {
      const { service, registry, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: '-1008888888888' }));

      const result = await service.approve(1, 'web_only');

      expect(result?.verdict).toBe(CandidateVerdict.APPROVED);
      expect(registry.addSource).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: -1008888888888, status: 'web_only' })
      );
    });

    it('нет кандидата → null', async () => {
      const { service } = setup();
      expect(await service.approve(99, 'join')).toBeNull();
    });

    it('кандидат не READY → null и причина approve-blocked', async () => {
      const { service, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.PENDING }));

      const result = await service.approve(1, 'web_only');

      expect(result).toBeNull();
      expect(candidateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'approve-blocked:pending' })
      );
    });

    it('исключённый источник → REJECTED source-excluded', async () => {
      const { service, registry, candidateRepo } = setup();
      registry.isExcluded.mockResolvedValue(true);
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: '-1008888888888' }));

      const result = await service.approve(1, 'web_only');

      expect(result?.verdict).toBe(CandidateVerdict.REJECTED);
      expect(result?.reason).toBe('source-excluded');
    });

    it('join: джойн не удался → null join-failed', async () => {
      const { service, candidateRepo } = setup({
        client: { invoke: jest.fn().mockResolvedValue(null) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: '-1008888888888' }));

      const result = await service.approve(1, 'join');

      expect(result).toBeNull();
      expect(candidateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ reason: 'join-failed' }));
    });

    it('join: успех помечает joined и активный статус', async () => {
      const { service, registry, candidateRepo } = setup({
        client: { invoke: jest.fn().mockResolvedValue({}) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: '-1008888888888' }));

      const result = await service.approve(1, 'join');

      expect(result?.verdict).toBe(CandidateVerdict.APPROVED);
      expect(result?.reason).toBe('joined');
      expect(registry.addSource).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });

    it('join: третий джойн за сутки блокируется', async () => {
      const { service, candidateRepo } = setup({
        client: { invoke: jest.fn().mockResolvedValue({}) },
      });

      for (let i = 0; i < 2; i += 1) {
        candidateRepo.findOne.mockResolvedValue(
          candidate({ id: 10 + i, verdict: CandidateVerdict.READY, chatId: `-10088888888${i}` })
        );
        await service.approve(10 + i, 'join');
      }
      candidateRepo.findOne.mockResolvedValue(candidate({ id: 12, verdict: CandidateVerdict.READY, chatId: '-1008888888812' }));
      const third = await service.approve(12, 'join');

      expect(third).toBeNull();
      expect(candidateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ reason: 'join-daily-cap' }));
    });

    it('chatId не резолвится → null', async () => {
      const { service, candidateRepo } = setup({
        client: { getEntity: jest.fn().mockResolvedValue({}) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: null, username: 'linked' }));

      const result = await service.approve(1, 'web_only');

      expect(result).toBeNull();
      expect(candidateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'chatId-unresolved' })
      );
    });

    it('chatId берётся из getEntity', async () => {
      const { service, registry, candidateRepo } = setup({
        client: { getEntity: jest.fn().mockResolvedValue({ id: bigInt('8888888888') }) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: null, username: 'linked' }));

      const result = await service.approve(1, 'web_only');

      expect(result?.verdict).toBe(CandidateVerdict.APPROVED);
      expect(registry.addSource).toHaveBeenCalledWith(expect.objectContaining({ chatId: -1008888888888 }));
    });

    it('username не резолвится внутри approve → null', async () => {
      const { service, candidateRepo } = setup({
        client: { getEntity: jest.fn().mockResolvedValue(undefined) },
      });
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: null, username: null }));

      expect(await service.approve(1, 'join')).toBeNull();
    });

    it('approve без клиента и без chatId → null', async () => {
      const { service, candidateRepo } = setup();
      (service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: null, username: 'linked' }));

      expect(await service.approve(1, 'web_only')).toBeNull();
    });
  });

  describe('autoApprove', () => {
    it('делегирует в approve с web_only', async () => {
      const { service, registry, candidateRepo } = setup();
      candidateRepo.findOne.mockResolvedValue(candidate({ verdict: CandidateVerdict.READY, chatId: '-1008888888888' }));

      await service.autoApprove(candidate({ id: 1, verdict: CandidateVerdict.READY }));

      expect(registry.addSource).toHaveBeenCalled();
    });
  });
});
