import { Logger } from '@nestjs/common';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { EvalStage, ObservedStatus, QUEUE_EMERGENCY_CAP } from '../constants/parser.constants';
import { metrics } from '../../../shared/metrics';
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
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => builder),
    builder,
  };
};

/** Мок мапит `update` (criteria, patch); достаём patch по id строки. */
const patchFor = (observedRepo: any, id: number): any => {
  const call = observedRepo.update.mock.calls.find(([criteria]: any[]) => criteria?.id === id);
  return call?.[1];
};

/** Критерии guarded-записи (`update`) для строки. */
const criteriaFor = (observedRepo: any, id: number): any => {
  const call = observedRepo.update.mock.calls.find(([criteria]: any[]) => criteria?.id === id);
  return call?.[0];
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

const makeGuard = (): any => ({
  run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()),
  isBlocked: jest.fn(() => false),
  blockedUntil: jest.fn(() => null),
});

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
    refreshBatchSize: 120,
    refreshStaleHours: 12,
    forceRefreshWindowHours: 168,
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
  (service as never as { pace: unknown }).pace = jest.fn().mockResolvedValue(undefined);
  const queueFinds = (dueRows: unknown[], expiredRows: unknown[] = []): void => {
    observedRepo.find.mockResolvedValueOnce(expiredRows).mockResolvedValueOnce(dueRows);
  };
  return {
    service,
    observedRepo,
    registry,
    client,
    ai: (service as never as { ai: any }).ai,
    queueFinds,
  };
};

describe('ParserEvaluatorService', () => {
  it('MTProto на паузе (FloodWait) → оценка и актуализация не дёргают Telegram', async () => {
    const observedRepo = makeObservedRepo();
    const registry = makeRegistry();
    const client = makeParserClient();
    const guard = makeGuard();
    guard.isBlocked.mockReturnValue(true);
    guard.blockedUntil.mockReturnValue(1_800_000_000_000);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new ParserEvaluatorService(
      observedRepo,
      registry,
      client,
      guard,
      makeSettings(),
      makeAi(),
      makeClock(),
      makeRandom()
    );
    (service as never as { pace: unknown }).pace = jest.fn().mockResolvedValue(undefined);

    // Дозревший кандидат есть, но пауза — до MTProto не доходим.
    observedRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate({ createdAt: hoursAgo(13) })]);
    expect(await service.evaluateDue()).toBe(0);
    expect(client.client().getMessages).not.toHaveBeenCalled();

    // Актуализация пула: источник в пачке есть, MTProto тоже не трогаем.
    observedRepo.find.mockResolvedValueOnce([
      candidate({
        status: ObservedStatus.SCORED,
        evalStage: EvalStage.FINAL,
        evaluatedAt: hoursAgo(30),
      }),
    ]);
    expect(await service.refreshScored()).toBe(0);
    expect(client.client().getMessages).not.toHaveBeenCalled();
    expect(registry.repository.findOne).not.toHaveBeenCalled();
    // Лог паузы — один на дедлайн, а не на каждый цикл.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('финальная оценка: пороги пройдены → scored FINAL', async () => {
    const { service, observedRepo, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(13) },
      messages: [freshMessage({ views: 4000 })],
    });
    queueFinds([candidate({ createdAt: hoursAgo(13) })]);

    const evaluated = await service.evaluateDue();

    expect(evaluated).toBe(1);
    // Guarded-запись: ожидаемый статус на момент чтения — PENDING.
    expect(criteriaFor(observedRepo, 10)).toMatchObject({ id: 10, status: ObservedStatus.PENDING });
    expect(patchFor(observedRepo, 10)).toMatchObject({
      status: ObservedStatus.SCORED,
      evalStage: EvalStage.FINAL,
      views: 4000,
      score: expect.any(Number),
    });
  });

  it('финальная оценка: пороги не пройдены → rejected с причинами', async () => {
    const { service, observedRepo, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(13) },
      messages: [freshMessage({ views: 100, reactions: { results: [] } })],
    });
    queueFinds([candidate({ createdAt: hoursAgo(13) })]);

    await service.evaluateDue();

    expect(patchFor(observedRepo, 10)).toMatchObject({
      status: ObservedStatus.REJECTED,
      rejectReason: expect.stringContaining('views<'),
    });
  });

  it('раньше времени → не оцениваем', async () => {
    const { service, observedRepo, queueFinds } = setup({});
    queueFinds([candidate({ createdAt: hoursAgo(1) })]);

    expect(await service.evaluateDue()).toBe(0);
    expect(observedRepo.update).not.toHaveBeenCalled();
  });

  it('pre-оценка (2ч) → scored PRE, не rejected', async () => {
    const { service, observedRepo, queueFinds } = setup({
      candidate: { createdAt: hoursAgo(3) },
      messages: [freshMessage({ views: 100, reactions: { results: [] } })],
    });
    queueFinds([candidate({ createdAt: hoursAgo(3) })]);

    await service.evaluateDue();

    expect(patchFor(observedRepo, 10)).toMatchObject({
      status: ObservedStatus.SCORED,
      evalStage: EvalStage.PRE,
    });
  });

  it('TTL истёк → expired', async () => {
    const { service, observedRepo, queueFinds } = setup({});
    observedRepo.find.mockResolvedValueOnce([candidate({ createdAt: hoursAgo(100) })]);
    observedRepo.find.mockResolvedValueOnce([]);

    await service.evaluateDue();

    expect(observedRepo.update).toHaveBeenCalledWith(
      { id: 10, status: ObservedStatus.PENDING },
      expect.objectContaining({ status: ObservedStatus.EXPIRED, rejectReason: 'ttl-48h' })
    );
  });

  it('нет базлайна → кандидат ждёт', async () => {
    const { service, observedRepo, queueFinds } = setup({ baseline: null });
    queueFinds([candidate({})]);

    expect(await service.evaluateDue()).toBe(0);
    expect(observedRepo.update).not.toHaveBeenCalled();
  });

  it('источник удалён → rejected source-missing', async () => {
    const { service, observedRepo, queueFinds } = setup({});
    (service as never as { registry: any }).registry.repository.findOne.mockResolvedValue(null);
    queueFinds([candidate({})]);

    await service.evaluateDue();

    expect(patchFor(observedRepo, 10)).toMatchObject({
      status: ObservedStatus.REJECTED,
      rejectReason: 'source-missing',
    });
  });

    it('сообщение исчезло → rejected message-gone', async () => {
      const { service, observedRepo, queueFinds } = setup({ messages: [] });
      queueFinds([candidate()]);

      await service.evaluateDue();

      expect(patchFor(observedRepo, 10)).toMatchObject({
        status: ObservedStatus.REJECTED,
        rejectReason: 'message-gone',
      });
    });

    it('null в ответе getMessages игнорируется', async () => {
      const { service, observedRepo, queueFinds } = setup({ messages: [null] });
      queueFinds([candidate()]);

      await service.evaluateDue();

      expect(patchFor(observedRepo, 10)).toMatchObject({
        status: ObservedStatus.REJECTED,
        rejectReason: 'message-gone',
      });
    });

    it('сообщение без views/reactions → 0', async () => {
      const { service, observedRepo, queueFinds } = setup({ messages: [{ id: 42 }] });
      queueFinds([candidate()]);

      await service.evaluateDue();

      expect(patchFor(observedRepo, 10)).toMatchObject({ views: 0, reactions: 0 });
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

    expect(patchFor(observedRepo, 10)).toMatchObject({
      status: ObservedStatus.SCORED,
      evalStage: EvalStage.FINAL,
    });
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

    expect(patchFor(observedRepo, 10)).toMatchObject({
      status: ObservedStatus.REJECTED,
      rejectReason: 'ai:ad',
    });
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
      expect(observedRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
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
      expect(observedRepo.update).not.toHaveBeenCalled();
    });

    it('гонка с селектором: affected=0 → строка не считается форснутой', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([candidate({ id: 1, mediaUniqueId: 'm1' })]);
      observedRepo.update.mockResolvedValue({});

      expect(await service.promoteForced(NOW)).toBe(0);
    });

    it('нет групп → 0', async () => {
      const { service } = setup({});
      expect(await service.promoteForced(NOW)).toBe(0);
    });

    it('окно поиска параметризуется (168ч для актуализации)', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([candidate({ id: 1, mediaUniqueId: 'm1' })]);

      expect(await service.promoteForced(NOW, 168)).toBe(1);
      expect(observedRepo.builder.andWhere).toHaveBeenCalledWith('o.createdAt >= :since', {
        since: new Date(NOW.getTime() - 168 * 3_600_000),
      });
    });
  });

  describe('пауза оценки при переполненном бэклоге', () => {
    it('бэклог ≥ QUEUE_EMERGENCY_CAP → оценка не запускается', async () => {
      const { service, observedRepo, queueFinds } = setup({});
      observedRepo.count.mockResolvedValue(QUEUE_EMERGENCY_CAP);
      queueFinds([candidate()]);

      expect(await service.evaluateDue()).toBe(0);
      expect(service.lastEvaluateStats).toEqual({ expired: 0, forced: 0 });
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('при переполненном бэклоге форс всё равно промоутится', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.count.mockResolvedValue(QUEUE_EMERGENCY_CAP);
      observedRepo.builder.getRawMany.mockResolvedValue([{ media: 'm1' }]);
      observedRepo.find.mockResolvedValue([candidate({ id: 1, mediaUniqueId: 'm1' })]);

      expect(await service.evaluateDue()).toBe(0);
      expect(service.lastEvaluateStats.forced).toBe(1);
      expect(observedRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ forced: true })
      );
    });
  });

  describe('refreshScored', () => {
    const staleRow = (overrides: Record<string, unknown> = {}): any =>
      candidate({
        status: ObservedStatus.SCORED,
        evalStage: EvalStage.FINAL,
        evaluatedAt: hoursAgo(20),
        refreshCount: 0,
        ...overrides,
      });

    it('перечитывает протухшие посты и обновляет score/evaluatedAt/refreshedAt/refreshCount', async () => {
      const { service, observedRepo, registry, client } = setup({
        settings: { refreshStaleHours: 12, refreshBatchSize: 120 },
      });
      const rows = [staleRow({ id: 10 }), staleRow({ id: 11, refreshCount: 3 })];
      observedRepo.find.mockResolvedValue(rows);
      client.client().getMessages.mockResolvedValue([
        freshMessage({ id: 42, views: 4000 }),
        freshMessage({ id: 42, views: 4000 }),
      ]);

      expect(await service.refreshScored()).toBe(2);

      expect(observedRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ObservedStatus.SCORED,
            evalStage: EvalStage.FINAL,
            forced: false,
            evaluatedAt: expect.anything(),
          }),
          order: { evaluatedAt: 'ASC' },
          take: 120,
        })
      );
      // Один MTProto-вызов на источник (оба поста — из одного канала).
      expect(client.client().getMessages).toHaveBeenCalledTimes(1);
      expect(registry.repository.findOne).toHaveBeenCalledTimes(1);
      // Guarded-запись на SCORED: строку мог забрать селектор.
      expect(criteriaFor(observedRepo, 10)).toMatchObject({ id: 10, status: ObservedStatus.SCORED });
      expect(patchFor(observedRepo, 10)).toMatchObject({
        status: ObservedStatus.SCORED,
        evaluatedAt: NOW,
        refreshedAt: NOW,
        refreshCount: 1,
        score: expect.any(Number),
        rejectReason: null,
      });
      expect(patchFor(observedRepo, 11)).toMatchObject({ refreshCount: 4 });
      // Актуализация — не выбор владельца: счётчик взятий источника не растёт.
      expect(registry.repository.save).not.toHaveBeenCalled();
    });

    it('guard miss (affected=0): строка не воскрешается и счётчики не бампаются', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, registry, client } = setup({});
      const row = staleRow({ id: 21, refreshCount: 2 });
      observedRepo.find.mockResolvedValue([row]);
      client.client().getMessages.mockResolvedValue([freshMessage({ id: 42, views: 4000 })]);
      // Селектор забрал строку между чтением и записью.
      observedRepo.update.mockResolvedValue({ affected: 0 });

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).toHaveBeenCalledWith(
        { id: 21, status: ObservedStatus.SCORED },
        expect.anything()
      );
      expect(registry.repository.save).not.toHaveBeenCalled();
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('guard miss без affected → skipped (UpdateResult без affected)', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, client } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 22 })]);
      client.client().getMessages.mockResolvedValue([freshMessage({ id: 42, views: 4000 })]);
      observedRepo.update.mockResolvedValue({});

      expect(await service.refreshScored()).toBe(0);
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('guard miss на порогах → skipped, отказ не записан', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, client } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 23 })]);
      client.client().getMessages.mockResolvedValue([
        freshMessage({ id: 42, views: 100, reactions: { results: [] } }),
      ]);
      observedRepo.update.mockResolvedValue({ affected: 0 });

      expect(await service.refreshScored()).toBe(0);
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('guard miss на message-gone → skipped', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, client } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 24 })]);
      client.client().getMessages.mockResolvedValue([]);
      observedRepo.update.mockResolvedValue({ affected: 0 });

      expect(await service.refreshScored()).toBe(0);
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('guard miss на пропавшем источнике → skipped', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, registry } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 25 })]);
      registry.repository.findOne.mockResolvedValue(null);
      observedRepo.update.mockResolvedValue({ affected: 0 });

      expect(await service.refreshScored()).toBe(0);
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('AI-отказ в актуализации помечается re-eval: и пишется guarded по SCORED', async () => {
      const { service, observedRepo, client } = setup({ settings: { aiEnabled: true } });
      observedRepo.find.mockResolvedValue([staleRow({ id: 26 })]);
      client.client().getMessages.mockResolvedValue([freshMessage({ id: 42, views: 4000 })]);
      (service as never as { ai: any }).ai.rejectPostIfTrash.mockResolvedValue('ai:ad');

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).toHaveBeenCalledWith(
        { id: 26, status: ObservedStatus.SCORED },
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 're-eval:ai:ad' })
      );
    });

    it('AI-отказ + guard miss → skipped, без записи', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, client } = setup({ settings: { aiEnabled: true } });
      observedRepo.find.mockResolvedValue([staleRow({ id: 27 })]);
      client.client().getMessages.mockResolvedValue([freshMessage({ id: 42, views: 4000 })]);
      (service as never as { ai: any }).ai.rejectPostIfTrash.mockResolvedValue('ai:ad');
      observedRepo.update.mockResolvedValue({ affected: 0 });

      expect(await service.refreshScored()).toBe(0);
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('guard miss на свежей оценке: вердикт не пишется, evaluated=0, взятия не бампнутся', async () => {
      const { service, observedRepo, registry, queueFinds } = setup({
        candidate: { createdAt: hoursAgo(13) },
        messages: [freshMessage({ views: 4000 })],
      });
      observedRepo.update.mockResolvedValue({ affected: 0 });
      queueFinds([candidate({ createdAt: hoursAgo(13) })]);

      expect(await service.evaluateDue()).toBe(0);
      expect(registry.repository.save).not.toHaveBeenCalled();
    });

    it('группирует по источникам: один getMessages на канал', async () => {
      const { service, observedRepo, registry, client } = setup({});
      observedRepo.find.mockResolvedValue([
        staleRow({ id: 1, sourceChatId: '-100aaa', sourceMessageId: 11 }),
        staleRow({ id: 2, sourceChatId: '-100bbb', sourceMessageId: 22 }),
      ]);
      registry.repository.findOne.mockImplementation(async ({ where }: any) =>
        source({ chatId: where.chatId, username: `u${where.chatId}` })
      );
      client.client().getMessages.mockImplementation(async (_peer: unknown, { ids }: any) =>
        ids.map((id: number) => freshMessage({ id, views: 4000 }))
      );

      expect(await service.refreshScored()).toBe(2);
      expect(client.client().getMessages).toHaveBeenCalledTimes(2);
      expect(client.client().getMessages).toHaveBeenCalledWith('u-100aaa', { ids: [11] });
      expect(client.client().getMessages).toHaveBeenCalledWith('u-100bbb', { ids: [22] });
    });

    it('источник пропал → REJECTED source-missing', async () => {
      const { service, observedRepo, registry } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 12 })]);
      registry.repository.findOne.mockResolvedValue(null);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).toHaveBeenCalledWith(
        { id: 12, status: ObservedStatus.SCORED },
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'source-missing' })
      );
    });

    it('без username берёт bigInt(chatId), groupIds добивает ids, null-элемент игнорируется', async () => {
      const { service, observedRepo, registry, client } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 13, groupIds: [43, 44] })]);
      registry.repository.findOne.mockResolvedValue(source({ username: null, chatId: '-100777' }));
      client.client().getMessages.mockResolvedValue([
        null,
        freshMessage({ id: 42, views: 4000 }),
      ]);

      expect(await service.refreshScored()).toBe(1);
      expect(client.client().getMessages).toHaveBeenCalledWith(expect.anything(), { ids: [42, 43, 44] });
      expect(patchFor(observedRepo, 13)).toMatchObject({
        status: ObservedStatus.SCORED,
        refreshCount: 1,
      });
    });

    it('чанкует ids по 100 за вызов getMessages', async () => {
      const { service, observedRepo, client } = setup({});
      const groupIds = Array.from({ length: 150 }, (_, i) => 1000 + i);
      observedRepo.find.mockResolvedValue([staleRow({ id: 14, groupIds })]);
      client.client().getMessages.mockImplementation(async (_peer: unknown, { ids }: any) =>
        ids.map((id: number) => freshMessage({ id, views: 4000 }))
      );

      expect(await service.refreshScored()).toBe(1);
      // 151 id (пост + 150 альбома) → два вызова: 100 и 51.
      expect(client.client().getMessages).toHaveBeenCalledTimes(2);
      expect(client.client().getMessages.mock.calls[0][1].ids).toHaveLength(100);
      expect(client.client().getMessages.mock.calls[1][1].ids).toHaveLength(51);
    });

    it('сообщение исчезло → REJECTED message-gone', async () => {
      const { service, observedRepo, client } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 5 })]);
      client.client().getMessages.mockResolvedValue([]);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).toHaveBeenCalledWith(
        { id: 5, status: ObservedStatus.SCORED },
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'message-gone' })
      );
    });

    it('пороги больше не пройдены → REJECTED re-eval:<reasons>', async () => {
      const { service, observedRepo, client } = setup({});
      observedRepo.find.mockResolvedValue([staleRow({ id: 6 })]);
      client.client().getMessages.mockResolvedValue([
        freshMessage({ id: 42, views: 100, reactions: { results: [] } }),
      ]);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).toHaveBeenCalledWith(
        { id: 6, status: ObservedStatus.SCORED },
        expect.objectContaining({
          status: ObservedStatus.REJECTED,
          rejectReason: expect.stringMatching(/^re-eval:views</),
        })
      );
    });

    it('сетевой сбой guard (undefined) → источник пропущен, evaluatedAt не меняется', async () => {
      const { service, observedRepo, client } = setup({});
      const row = staleRow({ id: 7 });
      observedRepo.find.mockResolvedValue([row]);
      client.client().getMessages.mockResolvedValue(undefined);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).not.toHaveBeenCalled();
      expect(row.evaluatedAt).toEqual(hoursAgo(20));
    });

    it('нет клиента → 0 и выборка не читается', async () => {
      const { service, observedRepo } = setup({});
      (service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('аварийный бэклог ≥ QUEUE_EMERGENCY_CAP → 0', async () => {
      const { service, observedRepo } = setup({});
      observedRepo.count.mockResolvedValue(QUEUE_EMERGENCY_CAP);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('нет базлайна у источника → пропуск без изменений', async () => {
      const { service, observedRepo, registry } = setup({ baseline: null });
      observedRepo.find.mockResolvedValue([staleRow({ id: 8 })]);
      registry.seedBaselineFromHistory.mockResolvedValue(null);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).not.toHaveBeenCalled();
    });

    it('пустая пачка: пересечения всё равно перепроверяются с настройкой окна', async () => {
      const { service, observedRepo } = setup({ settings: { forceRefreshWindowHours: 24 } });
      observedRepo.find.mockResolvedValue([]);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.createQueryBuilder).toHaveBeenCalledWith('o');
      expect(observedRepo.builder.andWhere).toHaveBeenCalledWith('o.createdAt >= :since', {
        since: new Date(NOW.getTime() - 24 * 3_600_000),
      });
    });

    it('считает результаты в метрике parser.refreshed', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, client } = setup({});
      // Первый пост перечитан успешно, второй исчез.
      observedRepo.find.mockResolvedValue([
        staleRow({ id: 9, sourceMessageId: 42 }),
        staleRow({ id: 10, sourceMessageId: 999 }),
      ]);
      client.client().getMessages.mockResolvedValue([freshMessage({ id: 42, views: 4000 })]);

      await service.refreshScored();

      expect(incSpy).toHaveBeenCalledWith({ result: 'refreshed' });
      expect(incSpy).toHaveBeenCalledWith({ result: 'gone' });
      incSpy.mockRestore();
    });

    it('сетевой сбой guard: источник пропущен целиком, метрика skipped, записей нет', async () => {
      const incSpy = jest.spyOn(metrics.parser.refreshed, 'inc');
      const { service, observedRepo, client } = setup({});
      // Оба поста из одного канала — сбой getMessages не должен тронуть ни один.
      observedRepo.find.mockResolvedValue([staleRow({ id: 7 }), staleRow({ id: 8 })]);
      client.client().getMessages.mockResolvedValue(undefined);

      expect(await service.refreshScored()).toBe(0);
      expect(observedRepo.update).not.toHaveBeenCalled();
      expect(incSpy).toHaveBeenCalledWith({ result: 'skipped' });
      incSpy.mockRestore();
    });

    it('сбой одного источника не мешает актуализации другого', async () => {
      const { service, observedRepo, registry, client } = setup({});
      observedRepo.find.mockResolvedValue([
        staleRow({ id: 1, sourceChatId: '-100aaa', sourceMessageId: 11 }),
        staleRow({ id: 2, sourceChatId: '-100bbb', sourceMessageId: 22 }),
      ]);
      registry.repository.findOne.mockImplementation(async ({ where }: any) =>
        source({ chatId: where.chatId, username: `u${where.chatId}` })
      );
      client.client().getMessages.mockImplementation(async (peer: unknown) =>
        peer === 'u-100aaa' ? undefined : [freshMessage({ id: 22, views: 4000 })]
      );

      expect(await service.refreshScored()).toBe(1);
      expect(patchFor(observedRepo, 2)).toMatchObject({
        status: ObservedStatus.SCORED,
        refreshCount: 1,
      });
      expect(observedRepo.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        expect.anything()
      );
    });

    it('сначала самые давно оценённые: evaluatedAt ASC и take=batch', async () => {
      const { service, observedRepo } = setup({
        settings: { refreshBatchSize: 7 },
      });
      observedRepo.find.mockResolvedValue([]);

      await service.refreshScored();

      expect(observedRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { evaluatedAt: 'ASC' },
          take: 7,
        })
      );
    });
  });

  it('pace реально ждёт (без подмены)', async () => {
    const { service } = setup({});
    delete (service as never as { pace?: unknown }).pace;
    await expect(
      (service as never as { pace: (ms: number) => Promise<void> }).pace(0)
    ).resolves.toBeUndefined();
  });

  describe('граничные ветки оценки', () => {
    it('SCORED+PRE раньше финала → пропуск', async () => {
      const { service, observedRepo, queueFinds } = setup({});
      queueFinds([candidate({ status: ObservedStatus.SCORED, evalStage: EvalStage.PRE, createdAt: hoursAgo(3) })]);

      expect(await service.evaluateDue()).toBe(0);
      expect(observedRepo.update).not.toHaveBeenCalled();
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
      expect(observedRepo.update).toHaveBeenCalled();
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

      expect(patchFor(observedRepo, 1)).toMatchObject({ forced: true, evaluatedAt: hoursAgo(1) });
    });
  });
});
