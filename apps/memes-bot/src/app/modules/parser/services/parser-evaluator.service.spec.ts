import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { EvalStage, ObservedStatus } from '../constants/parser.constants';
import { ParserEvaluatorService } from './parser-evaluator.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const NOW = new Date('2026-09-19T12:00:00Z');

const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

const baseline = { vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 30 };

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1008888888888',
  rawChatId: '8888888888',
  username: 'memes_source',
  category: 'memes',
  status: 'active',
  selectedTotal: 0,
  rejectedTotal: 0,
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): any => ({
  id: 10,
  sourceChatId: '-1008888888888',
  sourceMessageId: 42,
  groupIds: null,
  caption: null,
  mediaKind: 'photo',
  views: null,
  reactions: null,
  metrics: null,
  score: null,
  status: ObservedStatus.PENDING,
  evalStage: EvalStage.PRE,
  rejectReason: null,
  createdAt: hoursAgo(13),
  ...overrides,
});

const freshMessage = (overrides: Record<string, unknown> = {}): any => ({
  id: 42,
  views: 4000,
  reactions: {
    results: [
      { reaction: new Api.ReactionEmoji({ emoticon: '🔥' }), count: 40 },
      { reaction: new Api.ReactionEmoji({ emoticon: '🔥' }), count: 10 },
    ],
  },
  ...overrides,
});

void bigInt;

const makeObservedRepo = (): any => ({
  find: jest.fn().mockResolvedValue([]),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeRegistry = (overrides: Record<string, unknown> = {}): any => ({
  repository: {
    findOne: jest.fn().mockResolvedValue(source(overrides)),
    save: jest.fn().mockImplementation(async (value) => value),
  },
  computeBaselineFor: jest.fn().mockResolvedValue(baseline),
});

const makeParserClient = (): any => {
  const inner = { getMessages: jest.fn().mockResolvedValue([freshMessage()]) };
  return { client: jest.fn(() => inner) };
};

const makeGuard = (): any => ({ run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()) });

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
    ...overrides,
  },
  enabled: true,
});

const makeAi = (): any => ({ rejectPostIfTrash: jest.fn().mockResolvedValue(null) });

const makeClock = (): any => ({ now: jest.fn(() => NOW) });
const makeRandom = (): any => ({ next: jest.fn().mockReturnValue(0) });

const setup = (overrides: {
  candidate?: Record<string, unknown>;
  source?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  messages?: unknown[];
  baseline?: unknown;
} = {}) => {
  const observedRepo = makeObservedRepo();
  const registry = makeRegistry(overrides.source ?? {});
  registry.computeBaselineFor.mockResolvedValue(
    'baseline' in overrides ? (overrides.baseline as never) : baseline
  );
  const client = makeParserClient();
  if (overrides.messages) {
    client.client().getMessages.mockResolvedValue(overrides.messages);
  }
  const service = new ParserEvaluatorService(
    observedRepo,
    registry,
    client,
    makeGuard(),
    makeSettings(overrides.settings ?? {}),
    makeAi(),
    makeClock(),
    makeRandom()
  );
  const queueFinds = (dueRows: unknown[], expiredRows: unknown[] = []): void => {
    observedRepo.find.mockResolvedValueOnce(expiredRows).mockResolvedValueOnce(dueRows);
  };
  return { service, observedRepo, registry, ai: (service as never as { ai: any }).ai, queueFinds };
};

describe('ParserEvaluatorService', () => {
  it('финальная оценка: пороги пройдены → scored FINAL', async () => {
    const { service, observedRepo, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(13) },
      messages: [freshMessage({ views: 4000 })],
    });
    queueFinds([candidate({ createdAt: hoursAgo(13) })]);

    const evaluated = await service.evaluateDue();

    expect(evaluated).toBe(1);
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ObservedStatus.SCORED,
        evalStage: EvalStage.FINAL,
        views: 4000,
        score: expect.any(Number),
      })
    );
  });

  it('финальная оценка: пороги не пройдены → rejected с причинами', async () => {
    const { service, observedRepo, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(13) },
      messages: [freshMessage({ views: 100, reactions: { results: [] } })],
    });
    queueFinds([candidate({ createdAt: hoursAgo(13) })]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: expect.stringContaining('views<') })
    );
  });

  it('раньше времени → не оцениваем', async () => {
    const { service, observedRepo, queueFinds } = setup({});
    queueFinds([candidate({ createdAt: hoursAgo(1) })]);

    expect(await service.evaluateDue()).toBe(0);
    expect(observedRepo.save).not.toHaveBeenCalled();
  });

  it('pre-оценка (2ч) → scored PRE, не rejected', async () => {
    const { service, observedRepo, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(3) },
      messages: [freshMessage({ views: 100, reactions: { results: [] } })],
    });
    queueFinds([candidate({ createdAt: hoursAgo(3) })]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.SCORED, evalStage: EvalStage.PRE })
    );
  });

  it('TTL истёк → expired', async () => {
    const { service, observedRepo, queueFinds } = setup({});
    observedRepo.find.mockResolvedValueOnce([candidate({ createdAt: hoursAgo(100) })]);
    observedRepo.find.mockResolvedValueOnce([]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.EXPIRED, rejectReason: 'ttl-48h' })
    );
  });

  it('нет базлайна → кандидат ждёт', async () => {
    const { service, observedRepo, queueFinds } = setup({ baseline: null });
    queueFinds([candidate({})]);

    expect(await service.evaluateDue()).toBe(0);
    expect(observedRepo.save).not.toHaveBeenCalled();
  });

  it('источник удалён → rejected source-missing', async () => {
    const { service, observedRepo, queueFinds } = setup({});
    (service as never as { registry: any }).registry.repository.findOne.mockResolvedValue(null);
    queueFinds([candidate({})]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'source-missing' })
    );
  });

  it('сообщение исчезло → rejected message-gone', async () => {
    const { service, observedRepo, queueFinds } = setup({ messages: [] });
    queueFinds([candidate({})]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'message-gone' })
    );
  });

  it('кринж-категория: порог по доле 🤡/💩', async () => {
    const { service, observedRepo, queueFinds } = setup({
      source: { category: 'cringe' },
      candidate: { createdAt: hoursAgo(13) },
      messages: [
        freshMessage({
          views: 4000,
          reactions: { results: [{ reaction: new Api.ReactionEmoji({ emoticon: '🤡' }), count: 10 }] },
        }),
      ],
    });
    queueFinds([candidate({ createdAt: hoursAgo(13) })]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.SCORED, evalStage: EvalStage.FINAL })
    );
  });

  it('AI-префильтр: реклама → rejected ai:ad', async () => {
    const { service, observedRepo, ai, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(13), caption: 'Подпись с рекламой' },
      settings: { aiEnabled: true },
      messages: [freshMessage({ views: 4000 })],
    });
    ai.rejectPostIfTrash.mockResolvedValue('ai:ad');
    queueFinds([candidate({ createdAt: hoursAgo(13), caption: 'реклама' })]);

    await service.evaluateDue();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'ai:ad' })
    );
  });

  describe('isEligible', () => {
    it('SCORED FINAL без причины → eligible', () => {
      const { service } = setup({});
      expect(service.isEligible(candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.FINAL, score: 2 }))).toBe(true);
    });

    it('SCORED PRE → только hot', () => {
      const { service } = setup({});
      expect(
        service.isEligible(candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.PRE, score: 5 }))
      ).toBe(true);
      expect(
        service.isEligible(candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.PRE, score: 2 }))
      ).toBe(false);
    });

    it('не SCORED → не eligible', () => {
      const { service } = setup({});
      expect(service.isEligible(candidate({ status: ObservedStatus.PENDING, evalStage: EvalStage.FINAL, score: 9 }))).toBe(false);
    });
  });
});
