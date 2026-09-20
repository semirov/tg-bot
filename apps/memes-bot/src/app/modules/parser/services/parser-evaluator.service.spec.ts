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

const makeObservedRepo = (): any => {
  const builder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return {
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn().mockImplementation(async (value) => value),
    createQueryBuilder: jest.fn(() => builder),
    builder,
  };
};

const makeRegistry = (overrides: Record<string, unknown> = {}): any => ({
  repository: {
    findOne: jest.fn().mockResolvedValue(source(overrides)),
    save: jest.fn().mockImplementation(async (value) => value),
  },
  computeBaselineFor: jest.fn().mockResolvedValue(baseline),
  seedBaselineFromHistory: jest.fn().mockResolvedValue(null),
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
      queueFinds([candidate()]);

      await service.evaluateDue();

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'message-gone' })
      );
    });

    it('null в ответе getMessages игнорируется', async () => {
      const { service, observedRepo, queueFinds } = setup({ messages: [null] });
      queueFinds([candidate()]);

      await service.evaluateDue();

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'message-gone' })
      );
    });

    it('сообщение без views/reactions → 0', async () => {
      const { service, observedRepo, queueFinds } = setup({ messages: [{ id: 42 }] });
      queueFinds([candidate()]);

      await service.evaluateDue();

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ views: 0, reactions: 0 })
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

    it('forced → eligible даже без SCORED', () => {
      const { service } = setup({});
      expect(service.isEligible(candidate({ forced: true, status: ObservedStatus.PENDING }))).toBe(true);
    });

    it('relax пропускает любой SCORED без причины', () => {
      const { service } = setup({});
      expect(
        service.isEligible(candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.PRE, score: 1 }), true)
      ).toBe(true);
    });

    it('rejectReason блокирует отбор', () => {
      const { service } = setup({});
      expect(
        service.isEligible(
          candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.FINAL, score: 9, rejectReason: 'x' })
        )
      ).toBe(false);
    });
  });

  describe('promoteForced', () => {
    it('группа из 3 каналов помечается forced', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([
        candidate({ id: 1, mediaUniqueId: 'm1', status: ObservedStatus.PENDING }),
        candidate({ id: 2, mediaUniqueId: 'm1', status: ObservedStatus.SCORED }),
      ]);

      const forced = await service.promoteForced(NOW);

      expect(forced).toBe(2);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          forced: true,
          status: ObservedStatus.SCORED,
          evalStage: EvalStage.FINAL,
          rejectReason: null,
        })
      );
    });

    it('уже форс-посты не считаются повторно', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([candidate({ id: 1, mediaUniqueId: 'm1', forced: true })]);

      expect(await service.promoteForced(NOW)).toBe(0);
      expect(observedRepo.save).not.toHaveBeenCalled();
    });

    it('нет групп → 0', async () => {
      const { service } = setup({});
      expect(await service.promoteForced(NOW)).toBe(0);
    });
  });

  describe('пауза оценки при переполненном бэклоге', () => {
    it('бэклог > EVAL_PAUSE_BACKLOG → оценка не запускается', async () => {
      const { service, observedRepo, queueFinds } = setup({});
      observedRepo.count.mockResolvedValue(401);
      queueFinds([candidate()]);

      expect(await service.evaluateDue()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('при переполненном бэклоге форс всё равно промоутится', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.count.mockResolvedValue(401);
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([candidate({ id: 1, mediaUniqueId: 'm1' })]);

      expect(await service.evaluateDue()).toBe(0);
      expect(observedRepo.save).toHaveBeenCalledWith(expect.objectContaining({ forced: true }));
    });
  });

  describe('граничные ветки оценки', () => {
    it('SCORED+PRE раньше финала → пропуск', async () => {
      const { service, observedRepo, queueFinds } = setup({});
      queueFinds([candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.PRE, createdAt: hoursAgo(3) })]);

      expect(await service.evaluateDue()).toBe(0);
      expect(observedRepo.save).not.toHaveBeenCalled();
    });

    it('свежий сохранённый базлайн используется без пересчёта', async () => {
      const { service, observedRepo, registry, queueFinds } = setup({
        source: { baseline: { vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 30, updatedAt: NOW.toISOString() } },
        candidate: { createdAt: hoursAgo(13) },
        messages: [freshMessage({ views: 4000 })],
      });
      queueFinds([candidate({ createdAt: hoursAgo(13) })]);

      await service.evaluateDue();

      expect(registry.computeBaselineFor).not.toHaveBeenCalled();
      expect(observedRepo.save).toHaveBeenCalled();
    });

    it('базлайн без updatedAt считается протухшим', async () => {
      const { service, registry, queueFinds } = setup({
        source: { baseline: { vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 30 } },
        candidate: { createdAt: hoursAgo(13) },
        messages: [freshMessage({ views: 4000 })],
      });
      queueFinds([candidate({ createdAt: hoursAgo(13) })]);

      await service.evaluateDue();

      expect(registry.computeBaselineFor).toHaveBeenCalled();
    });

    it('promoteForced не перезаписывает evaluatedAt, если он есть', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([
        candidate({ id: 1, mediaUniqueId: 'm1', evaluatedAt: hoursAgo(1) }),
      ]);

      await service.promoteForced(NOW);

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ forced: true, evaluatedAt: hoursAgo(1) })
      );
    });
  });
});
