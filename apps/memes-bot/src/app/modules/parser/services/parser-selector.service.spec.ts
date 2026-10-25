import {
  AUTO_DELIVER_PER_CYCLE,
  BACKLOG_TTL_DAYS,
  DELIVERY_ATTEMPT_LIMIT,
  DELIVERY_RETRY_BACKOFF_MS,
  DUMP_COOLDOWN_MINUTES,
  DUMP_PER_SOURCE_CAP,
  FORCE_PER_CYCLE_CAP,
  ObservedStatus,
  POOL_TTL_DAYS,
  QUEUE_EMERGENCY_CAP,
  RANK_WINDOW,
} from '../constants/parser.constants';
import { ParserSelectorService } from './parser-selector.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const NOW = new Date('2026-09-19T12:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

const scoredRow = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  sourceChatId: '-1008888888888',
  mediaUniqueId: 'media-1',
  score: 5,
  status: ObservedStatus.SCORED,
  rejectReason: null,
  forced: false,
  evaluatedAt: NOW,
  refreshCount: 0,
  createdAt: NOW,
  requestChannelMessageId: null,
  ...overrides,
});

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1008888888888',
  category: 'memes',
  status: 'active',
  excluded: false,
  err: null,
  weight: 1,
  ...overrides,
});

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

const makeRegistry = (): any => ({
  repository: {
    find: jest.fn().mockResolvedValue([source()]),
    save: jest.fn().mockResolvedValue(undefined),
  },
  markSourceIgnored: jest.fn().mockResolvedValue(undefined),
});

const makeDelivery = (): any => ({
  deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }),
  attachMoreButton: jest.fn().mockResolvedValue(undefined),
  detachMoreButton: jest.fn().mockResolvedValue(undefined),
});

const makeSettings = (overrides: Record<string, unknown> = {}): any => ({
  current: {
    errMin: 0.15,
    dailyLimit: 0,
    sourceDailyCap: 0,
    refreshBatchSize: 120,
    refreshStaleHours: 12,
    forceRefreshWindowHours: 168,
    ...overrides,
  },
  enabled: true,
  boostActive: jest.fn(() => false),
});

const makeConfig = (): any => ({ userRequestMemeChannel: -1004444444444 });

const makeBot = (): any => ({
  api: {
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    editMessageCaption: jest.fn().mockResolvedValue(undefined),
  },
});

let clockNow = NOW;
const makeClock = (): any => ({ now: jest.fn(() => clockNow) });

const FORCE_BACKOFF_MS = DELIVERY_RETRY_BACKOFF_MS;

/**
 * Форс-пул так, как его отдаёт запрос: без строк, проваливавшихся внутри
 * окна бэкоффа (проверяем поведение выборки на «живом» наборе строк).
 */
const forcedPool = (rows: any[]): any[] =>
  rows.filter(
    (row) =>
      row.status === ObservedStatus.SCORED &&
      row.forced &&
      (row.lastDeliveryFailureAt == null ||
        clockNow.getTime() - new Date(row.lastDeliveryFailureAt).getTime() >= FORCE_BACKOFF_MS)
  );

const setup = (overrides: { settings?: Record<string, unknown> } = {}) => {
  const observedRepo = makeObservedRepo();
  const registry = makeRegistry();
  const delivery = makeDelivery();
  const clock = makeClock();
  const bot = makeBot();
  const settings = makeSettings(overrides.settings ?? {});
  const service = new ParserSelectorService(
    observedRepo,
    registry,
    delivery,
    settings,
    makeConfig(),
    bot,
    clock
  );
  (service as never as { pace: unknown }).pace = jest.fn().mockResolvedValue(undefined);
  return { service, observedRepo, registry, delivery, bot, clock, settings };
};

describe('ParserSelectorService', () => {
  beforeEach(() => {
    clockNow = NOW;
  });

  describe('deliverForced', () => {
    it('нет форс-постов → 0', async () => {
      const { service, delivery } = setup();
      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('доставляет форс-пост и переводит в DELIVERED', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);

      expect(await service.deliverForced()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledWith(row);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.SELECTED })
      );
    });

    it('исключённый источник пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow({ forced: true })]);
      registry.repository.find.mockResolvedValue([source({ excluded: true })]);

      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('низкий ERR источника пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow({ forced: true })]);
      registry.repository.find.mockResolvedValue([source({ err: 0.1 })]);

      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('транзиентный сбой доставки возвращает пост в SCORED', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);
      delivery.deliver.mockImplementation(async (candidate: any) => {
        candidate.rejectReason = 'send-failed';
        return { ok: false, status: ObservedStatus.FAILED };
      });

      expect(await service.deliverForced()).toBe(0);
      expect(observedRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ObservedStatus.SCORED, rejectReason: null })
      );
    });

    it('FAILED без rejectReason считается транзиентным', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);
      delivery.deliver.mockResolvedValue({ ok: false, status: ObservedStatus.FAILED });

      await service.deliverForced();

      expect(observedRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ObservedStatus.SCORED, rejectReason: null })
      );
    });

    it('терминальный сбой доставки переводит в REJECTED', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);
      delivery.deliver.mockImplementation(async (candidate: any) => {
        candidate.rejectReason = 'media-too-large';
        return { ok: false, status: ObservedStatus.FAILED };
      });

      await service.deliverForced();

      expect(observedRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ObservedStatus.REJECTED })
      );
    });

    it('занято общим мьютексом → 0', async () => {
      const { service, observedRepo, delivery } = setup();
      (service as never as { busy: boolean }).busy = true;
      observedRepo.find.mockResolvedValue([scoredRow({ forced: true })]);

      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('применяет кап по источнику в пределах FORCE_PER_CYCLE_CAP', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      const chatIds = Array.from({ length: 7 }, (_, i) => `-1000${i}`);
      const rows: any[] = [];
      let id = 0;
      for (const chatId of chatIds) {
        for (let i = 0; i < 4; i += 1) {
          id += 1;
          rows.push(scoredRow({ id, forced: true, sourceChatId: chatId, mediaUniqueId: `m-${id}` }));
        }
      }
      observedRepo.find.mockResolvedValue(rows);
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));

      expect(await service.deliverForced()).toBe(FORCE_PER_CYCLE_CAP);
      const counts = new Map<string, number>();
      for (const call of delivery.deliver.mock.calls) {
        const key = call[0].sourceChatId;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(DUMP_PER_SOURCE_CAP);
      expect(counts.get('-10000')).toBe(DUMP_PER_SOURCE_CAP);
    });

    it('аварийный порог бэклога останавливает форс-выдачу', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.count.mockResolvedValue(QUEUE_EMERGENCY_CAP);

      expect(await service.deliverForced()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('форс-пост не блокирует обычную выдачу (нет force-only очереди)', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        (Array.isArray(where) ? where.some((item: any) => item.forced) : where.forced) === true
          ? [scoredRow({ id: 1, forced: true, mediaUniqueId: 'f-1' })]
          : [scoredRow({ id: 2, mediaUniqueId: 'n-1' })]
      );
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverForced()).toBe(1);
      expect(await service.deliverDue()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(2);
      expect(delivery.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2 }));
    });

    it('выборка отсекает падавшие за последний час строки прямо в запросе', async () => {
      const { service, observedRepo } = setup();

      await service.deliverForced();

      const options = observedRepo.find.mock.calls[0][0];
      expect(options.take).toBe(FORCE_PER_CYCLE_CAP * 5);
      expect(options.order).toEqual({ createdAt: 'ASC' });
      expect(Array.isArray(options.where)).toBe(true);
      expect(options.where[0]).toMatchObject({ status: ObservedStatus.SCORED, forced: true });
      expect(options.where[0].lastDeliveryFailureAt).toMatchObject({ _type: 'isNull' });
      expect(options.where[1]).toMatchObject({ status: ObservedStatus.SCORED, forced: true });
      expect(options.where[1].lastDeliveryFailureAt).toMatchObject({ _type: 'lessThan' });
    });

    it('голова очереди в бэкоффе не запирает остальные строки в том же цикле', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      const chatIds = Array.from({ length: 7 }, (_, i) => `-1000${i}`);
      const rows = [
        scoredRow({
          id: 1,
          forced: true,
          sourceChatId: chatIds[0],
          mediaUniqueId: 'm-0',
          // Провал минуту назад: окно бэкоффа ещё не истекло.
          lastDeliveryFailureAt: new Date(NOW.getTime() - 60_000),
        }),
        ...chatIds
          .slice(1)
          .map((chatId, i) =>
            scoredRow({ id: i + 2, forced: true, sourceChatId: chatId, mediaUniqueId: `m-${i + 1}` })
          ),
      ];
      observedRepo.find.mockResolvedValue(rows);
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverForced()).toBe(FORCE_PER_CYCLE_CAP);
      expect(delivery.deliver).toHaveBeenCalledTimes(FORCE_PER_CYCLE_CAP);
      expect(delivery.deliver).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    it('три медиа-сбоя подряд → REJECTED, строка больше не выбирается', async () => {
      const { service, observedRepo, delivery } = setup();
      const rows = [
        scoredRow({ id: 1, forced: true, deliveryAttempts: null, lastDeliveryFailureAt: null }),
      ];
      observedRepo.find.mockImplementation(async () =>
        forcedPool(rows).slice(0, FORCE_PER_CYCLE_CAP * 5)
      );
      delivery.deliver.mockImplementation(async (row: any) => {
        row.rejectReason = 'media-fetch-failed';
        return { ok: false, status: ObservedStatus.FAILED, reason: 'media-fetch-failed' };
      });

      expect(await service.deliverForced()).toBe(0);
      expect(rows[0]).toMatchObject({
        status: ObservedStatus.SCORED,
        deliveryAttempts: 1,
        rejectReason: null,
        lastDeliveryFailureAt: NOW,
      });

      clockNow = new Date(NOW.getTime() + FORCE_BACKOFF_MS + 1);
      await service.deliverForced();
      expect(rows[0]).toMatchObject({ status: ObservedStatus.SCORED, deliveryAttempts: 2 });

      clockNow = new Date(NOW.getTime() + 2 * (FORCE_BACKOFF_MS + 1));
      await service.deliverForced();
      expect(rows[0]).toMatchObject({
        status: ObservedStatus.REJECTED,
        deliveryAttempts: DELIVERY_ATTEMPT_LIMIT,
        rejectReason: 'media-fetch-failed',
      });

      // Отклонённая строка выпадает из пула: доставка больше не вызывается.
      clockNow = new Date(NOW.getTime() + 3 * (FORCE_BACKOFF_MS + 1));
      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).toHaveBeenCalledTimes(DELIVERY_ATTEMPT_LIMIT);
    });

    it('сетевой сбой попытку не тратит и повторяется после бэкоффа', async () => {
      const { service, observedRepo, delivery } = setup();
      const rows = [
        scoredRow({ id: 1, forced: true, deliveryAttempts: null, lastDeliveryFailureAt: null }),
      ];
      observedRepo.find.mockImplementation(async () => forcedPool(rows));
      delivery.deliver.mockImplementation(async (row: any) => {
        row.rejectReason = 'network';
        return { ok: false, status: ObservedStatus.FAILED, reason: 'network' };
      });

      expect(await service.deliverForced()).toBe(0);
      expect(rows[0]).toMatchObject({
        status: ObservedStatus.SCORED,
        deliveryAttempts: null,
        rejectReason: null,
        lastDeliveryFailureAt: NOW,
      });

      // Внутри окна бэкоффа строку не трогаем — и не отклоняем.
      clockNow = new Date(NOW.getTime() + 20 * 60_000);
      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).toHaveBeenCalledTimes(1);

      // Окно истекло — строка снова в работе, сбой не накопился.
      clockNow = new Date(NOW.getTime() + FORCE_BACKOFF_MS + 1);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });
      expect(await service.deliverForced()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(2);
      expect((delivery.deliver.mock.calls[1][0] as any).deliveryAttempts).toBeNull();
    });
  });

  describe('dumpMore', () => {
    it('без кандидатов → 0', async () => {
      const { service, delivery } = setup();
      expect(await service.dumpMore()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('занят → 0', async () => {
      const { service, observedRepo } = setup();
      (service as never as { busy: boolean }).busy = true;
      observedRepo.find.mockResolvedValue([scoredRow()]);
      expect(await service.dumpMore()).toBe(0);
    });

    it('cooldown между доборами → 0', async () => {
      const { service, observedRepo } = setup();
      (service as never as { lastDumpAt: number }).lastDumpAt = NOW.getTime();
      expect(await service.dumpMore()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('не берёт форс-посты и отдаёт лучших по рангу первыми', async () => {
      const { service, observedRepo, delivery } = setup();
      const weaker = scoredRow({ id: 2, createdAt: NOW, score: 1, mediaUniqueId: 'weaker' });
      const better = scoredRow({ id: 1, createdAt: daysAgo(2), score: 9, mediaUniqueId: 'better' });
      observedRepo.find.mockResolvedValue([weaker, better]);
      delivery.deliver.mockImplementation(async (row: any) => {
        row.requestChannelMessageId = 500 + row.id;
        return { ok: true, status: ObservedStatus.DELIVERED };
      });

      expect(await service.dumpMore()).toBe(2);
      expect(observedRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ forced: false }) })
      );
      expect(delivery.deliver.mock.calls[0][0].id).toBe(1);
      expect(delivery.attachMoreButton).toHaveBeenCalledWith(502, 2);
    });

    it('снимает кнопку с прошлой последней карточки, найденной в БД', async () => {
      const { service, observedRepo, delivery } = setup();
      let deliveredRows: any[] = [scoredRow({ id: 1, createdAt: NOW })];
      observedRepo.find.mockImplementation(async ({ where }: any) => {
        if (where?.status === ObservedStatus.DELIVERED) {
          return [{ id: 1, requestChannelMessageId: 501, status: ObservedStatus.DELIVERED }];
        }
        return deliveredRows;
      });
      delivery.deliver.mockImplementation(async (row: any) => {
        row.requestChannelMessageId = 500 + row.id;
        return { ok: true, status: ObservedStatus.DELIVERED };
      });

      await service.dumpMore();

      clockNow = new Date(NOW.getTime() + (DUMP_COOLDOWN_MINUTES + 1) * 60_000);
      deliveredRows = [scoredRow({ id: 2, createdAt: clockNow })];
      await service.dumpMore();

      expect(delivery.detachMoreButton).toHaveBeenCalledWith(501, 1);
      expect(delivery.attachMoreButton).toHaveBeenLastCalledWith(502, 2);
    });

    it('кандидат без источника в мапе пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow({ sourceChatId: '-100none' })]);
      registry.repository.find.mockResolvedValue([source({ chatId: '-1008888888888' })]);

      expect(await service.dumpMore()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('без message_id кнопка «Ещё 20» не ставится', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.dumpMore()).toBe(1);
      expect(delivery.attachMoreButton).not.toHaveBeenCalled();
    });

    it('исключённые источники и дубли медиа не доставляются', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 1, sourceChatId: '-100aaa', mediaUniqueId: 'dup', score: 3 }),
        scoredRow({ id: 2, sourceChatId: '-100bbb', mediaUniqueId: 'dup', score: 7 }),
        scoredRow({ id: 3, sourceChatId: '-100ccc', mediaUniqueId: 'unique' }),
      ]);
      registry.repository.find.mockResolvedValue([
        source({ chatId: '-100aaa' }),
        source({ chatId: '-100bbb', excluded: true }),
        source({ chatId: '-100ccc' }),
      ]);

      await service.dumpMore();

      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    });
  });

  describe('deliverDue', () => {
    it('без кандидатов → 0 и доставка не вызывается', async () => {
      const { service, delivery } = setup();
      expect(await service.deliverDue()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('занят общим мьютексом → 0', async () => {
      const { service, observedRepo } = setup();
      (service as never as { busy: boolean }).busy = true;
      observedRepo.find.mockResolvedValue([scoredRow()]);
      expect(await service.deliverDue()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('отдаёт лучших по рангу первыми (не свежих) без кнопки «Ещё 20»', async () => {
      const { service, observedRepo, delivery } = setup();
      const newer = scoredRow({ id: 2, createdAt: NOW, score: 1, mediaUniqueId: 'newer' });
      const better = scoredRow({ id: 1, createdAt: daysAgo(2), score: 9, mediaUniqueId: 'better' });
      observedRepo.find.mockResolvedValue([newer, better]);
      delivery.deliver.mockImplementation(async (row: any) => {
        row.requestChannelMessageId = 500 + row.id;
        return { ok: true, status: ObservedStatus.DELIVERED };
      });

      expect(await service.deliverDue()).toBe(2);
      expect(delivery.deliver.mock.calls[0][0].id).toBe(1);
      expect(delivery.attachMoreButton).not.toHaveBeenCalled();
    });

    it('окно ранжирования: score DESC, не форс, RANK_WINDOW', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      await service.deliverDue();

      expect(observedRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ObservedStatus.SCORED,
            forced: false,
            rejectReason: expect.anything(),
          }),
          order: { score: 'DESC' },
          take: RANK_WINDOW,
        })
      );
      // NULL-скор не должен занимать окно (в PG NULL сортируется первым).
      const findWhere = observedRepo.find.mock.calls[0][0].where;
      expect(findWhere.score).toMatchObject({
        _type: 'not',
        _value: expect.objectContaining({ _type: 'isNull' }),
      });
    });

    it('тай-брейк: свежее evaluatedAt выше при равном ранге', async () => {
      const { service, observedRepo, delivery } = setup();
      const older = scoredRow({ id: 1, score: 5, evaluatedAt: daysAgo(2), mediaUniqueId: 'a' });
      const fresher = scoredRow({ id: 2, score: 5, evaluatedAt: NOW, mediaUniqueId: 'b' });
      observedRepo.find.mockResolvedValue([older, fresher]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      await service.deliverDue();

      expect(delivery.deliver.mock.calls[0][0].id).toBe(2);
    });

    it('тай-брейк: при равном ранге и evaluatedAt выше более новый createdAt', async () => {
      const { service, observedRepo, delivery } = setup();
      const older = scoredRow({ id: 1, score: 5, evaluatedAt: null, createdAt: daysAgo(2), mediaUniqueId: 'a' });
      const newer = scoredRow({ id: 2, score: 5, evaluatedAt: null, createdAt: NOW, mediaUniqueId: 'b' });
      observedRepo.find.mockResolvedValue([older, newer]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      await service.deliverDue();

      expect(delivery.deliver.mock.calls[0][0].id).toBe(2);
    });

    it('кап 3 на источник внутри одной порции', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      const chatIds = ['-100aaa', '-100bbb', '-100ccc'];
      const rows = chatIds.flatMap((chatId, index) =>
        Array.from({ length: 3 }, (_, i) =>
          scoredRow({ id: index * 3 + i + 1, sourceChatId: chatId, mediaUniqueId: `m-${index}-${i}` })
        )
      );
      observedRepo.find.mockResolvedValue(rows);
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      // Порция ограничена AUTO_DELIVER_PER_CYCLE (5), а не переданным count.
      expect(await service.deliverDue(9)).toBe(AUTO_DELIVER_PER_CYCLE);
      const counts = new Map<string, number>();
      for (const call of delivery.deliver.mock.calls) {
        counts.set(call[0].sourceChatId, (counts.get(call[0].sourceChatId) ?? 0) + 1);
      }
      expect(Math.max(...counts.values())).toBe(DUMP_PER_SOURCE_CAP);
    });

    it('не применяет cooldown ручного добора', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue(1)).toBe(1);
      expect(await service.deliverDue(1)).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(2);
    });

    it('исключённый источник никогда не доставляется', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow()]);
      registry.repository.find.mockResolvedValue([source({ excluded: true })]);

      expect(await service.deliverDue()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('низкий ERR источника (ниже errMin) пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup({
        settings: { errMin: 0.15 },
      });
      observedRepo.find.mockResolvedValue([scoredRow()]);
      registry.repository.find.mockResolvedValue([source({ err: 0.1 })]);

      expect(await service.deliverDue()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('дневной бюджет: 200 отдано сегодня → 0 и выборка не читается', async () => {
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.count.mockResolvedValue(200);
      observedRepo.find.mockResolvedValue([scoredRow()]);

      expect(await service.deliverDue()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('дневной разгон: 03:00 MSK → allowed 25, порция ≤ AUTO_DELIVER_PER_CYCLE', async () => {
      clockNow = new Date('2026-09-19T00:00:00Z'); // 03:00 MSK → allowed floor(200*3/24)=25
      const { service, observedRepo, registry, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.count.mockResolvedValue(0);
      const chatIds = Array.from({ length: AUTO_DELIVER_PER_CYCLE + 1 }, (_, i) => `-1000${i}`);
      observedRepo.find.mockResolvedValue(
        chatIds.map((chatId, i) => scoredRow({ id: i + 1, sourceChatId: chatId, mediaUniqueId: `m-${i}` }))
      );
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.remainingQuota()).toBe(AUTO_DELIVER_PER_CYCLE);
      expect(await service.deliverDue()).toBe(AUTO_DELIVER_PER_CYCLE);
    });

    it('дневной разгон: отдаёт только остаток разгона (не больше allowedByNow)', async () => {
      clockNow = new Date('2026-09-19T00:00:00Z'); // 03:00 MSK → allowed 25
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.count.mockResolvedValue(24);
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 1, mediaUniqueId: 'a' }),
        scoredRow({ id: 2, mediaUniqueId: 'b' }),
      ]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(1);
    });

    it('дневной разгон: разгон исчерпан → 0', async () => {
      clockNow = new Date('2026-09-19T00:00:00Z'); // allowed 25
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.count.mockResolvedValue(25);
      observedRepo.find.mockResolvedValue([scoredRow()]);

      expect(await service.deliverDue()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('dailyLimit = 0 → порция всё равно ограничена', async () => {
      clockNow = new Date('2026-09-19T00:00:00Z');
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 0 } });
      observedRepo.count.mockResolvedValue(500);
      observedRepo.find.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) =>
          scoredRow({ id: i + 1, sourceChatId: `-1000${i}`, mediaUniqueId: `m-${i}` })
        )
      );
      const chatIds = Array.from({ length: 10 }, (_, i) => `-1000${i}`);
      const registryFind = jest.fn().mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      (service as never as { registry: any }).registry.repository.find = registryFind;
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(AUTO_DELIVER_PER_CYCLE);
    });

    it('бюджет считает только не-форс посты', async () => {
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      await service.deliverDue();

      expect(observedRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ forced: false, deliveredAt: expect.anything() }),
        })
      );
    });

    it('бэклог 399 (бывший порог 400) больше не блокирует выдачу', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.count.mockResolvedValueOnce(399).mockResolvedValue(0);
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalled();
    });

    it('аварийный порог бэклога останавливает авто-выдачу', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.count.mockResolvedValue(QUEUE_EMERGENCY_CAP);
      observedRepo.find.mockResolvedValue([scoredRow()]);

      expect(await service.deliverDue()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('бюджет считает доставки по deliveredAt, а не по текущему статусу', async () => {
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      // 200 доставок сегодня; часть из них уже отклонена/склеена, но бюджет занят.
      observedRepo.count.mockResolvedValueOnce(0).mockResolvedValue(200);

      // Запрос бюджета не фильтрует статус — иначе отклонённая карточка вернула бы квоту.
      expect(await service.deliverDue()).toBe(0);
      expect(observedRepo.count).toHaveBeenCalledWith({
        where: { deliveredAt: expect.anything(), forced: false },
      });
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('две отклонённые сегодня карточки не открывают бюджет заново', async () => {
      const { service, observedRepo, delivery } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.find.mockResolvedValue([scoredRow()]);
      // 202 доставки (200 в бюджете + 2 отклонённые) — сверх лимита не отдаём.
      observedRepo.count.mockResolvedValueOnce(0).mockResolvedValue(202);

      expect(await service.deliverDue()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('кап на источник считает доставки по deliveredAt (без фильтра статуса)', async () => {
      const { service, observedRepo, registry, delivery } = setup({
        settings: { sourceDailyCap: 10 },
      });
      observedRepo.find.mockResolvedValue([scoredRow({ id: 1, sourceChatId: '-100aaa' })]);
      registry.repository.find.mockResolvedValue([source({ chatId: '-100aaa' })]);
      // 10 доставок с канала сегодня, часть уже отклонена — квота исчерпана.
      observedRepo.builder.getRawMany.mockResolvedValue([
        { sourceChatId: '-100aaa', delivered: '10' },
      ]);

      expect(await service.deliverDue()).toBe(0);
      expect(observedRepo.builder.andWhere).toHaveBeenCalledWith('o.deliveredAt >= :start', {
        start: expect.anything(),
      });
      expect(observedRepo.builder.andWhere).toHaveBeenCalledWith('o.forced = :forced', {
        forced: false,
      });
      const statusClauses = observedRepo.builder.andWhere.mock.calls.filter(([clause]: any[]) =>
        String(clause).includes('o.status')
      );
      expect(statusClauses).toHaveLength(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('кап на источник: исчерпанная квота считается одним GROUP BY', async () => {
      const { service, observedRepo, registry, delivery } = setup({
        settings: { sourceDailyCap: 1 },
      });
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 1, sourceChatId: '-100aaa', mediaUniqueId: 'a' }),
        scoredRow({ id: 2, sourceChatId: '-100bbb', mediaUniqueId: 'b' }),
      ]);
      registry.repository.find.mockResolvedValue([
        source({ chatId: '-100aaa' }),
        source({ chatId: '-100bbb' }),
      ]);
      observedRepo.builder.getRawMany.mockResolvedValue([
        { sourceChatId: '-100aaa', delivered: '1' },
      ]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(1);
      expect(observedRepo.createQueryBuilder).toHaveBeenCalledWith('o');
      expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    });

    it('кап на источник: в одном прогоне больше квоты не отдаёт', async () => {
      const { service, observedRepo, registry, delivery } = setup({
        settings: { sourceDailyCap: 1 },
      });
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 1, sourceChatId: '-100aaa', mediaUniqueId: 'a', createdAt: NOW }),
        scoredRow({
          id: 2,
          sourceChatId: '-100aaa',
          mediaUniqueId: 'b',
          createdAt: daysAgo(1),
        }),
      ]);
      registry.repository.find.mockResolvedValue([source({ chatId: '-100aaa' })]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    it('уважает переданный count-лимит', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) =>
          scoredRow({ id: i + 1, sourceChatId: `-100${i}`, mediaUniqueId: `m-${i}` })
        )
      );
      const chatIds = Array.from({ length: 5 }, (_, i) => `-100${i}`);
      (service as never as { registry: any }).registry.repository.find = jest
        .fn()
        .mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue(2)).toBe(2);
    });

    it('нулевой count → 0 и выборка не читается', async () => {
      const { service, observedRepo } = setup();
      observedRepo.count.mockResolvedValue(0);
      expect(await service.deliverDue(0)).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it(`дефолт — AUTO_DELIVER_PER_CYCLE (${AUTO_DELIVER_PER_CYCLE})`, async () => {
      const { service, observedRepo, delivery } = setup();
      const chatIds = Array.from({ length: 8 }, (_, i) => `-100${i}`);
      observedRepo.find.mockResolvedValue(
        Array.from({ length: AUTO_DELIVER_PER_CYCLE + 5 }, (_, i) =>
          scoredRow({ id: i + 1, sourceChatId: chatIds[i % 8], mediaUniqueId: `m-${i}` })
        )
      );
      (service as never as { registry: any }).registry.repository.find = jest
        .fn()
        .mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(AUTO_DELIVER_PER_CYCLE);
    });

    it('полный день: суммарно не больше dailyLimit и не больше порции за цикл', async () => {
      // Полночь MSK дня 2026-09-19 = 2026-09-18T21:00:00Z.
      const dayStart = Date.parse('2026-09-18T21:00:00Z');
      clockNow = new Date(dayStart);
      const { service, observedRepo, registry, delivery } = setup({
        settings: { dailyLimit: 200 },
      });
      const pool = Array.from({ length: 40 }, (_, i) =>
        scoredRow({ id: i + 1, sourceChatId: `-100s${i % 6}`, mediaUniqueId: `m-${i}`, score: 10 })
      );
      const chatIds = Array.from({ length: 6 }, (_, i) => `-100s${i}`);
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));

      const deliveredToday: any[] = [];
      observedRepo.count.mockImplementation(async ({ where }: any) =>
        where?.forced === false ? deliveredToday.length : 0
      );
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where?.forced === false ? pool : []
      );
      delivery.deliver.mockImplementation(async (row: any) => {
        deliveredToday.push(row);
        return { ok: true, status: ObservedStatus.DELIVERED };
      });

      let total = 0;
      let maxPerCycle = 0;
      for (let minute = 0; minute < 24 * 60; minute += 20) {
        clockNow = new Date(dayStart + minute * 60_000);
        const delivered = await service.deliverDue();
        total += delivered;
        maxPerCycle = Math.max(maxPerCycle, delivered);
      }

      // Линейный разгон (ceil): последний цикл суток — 23:40 MSK (1420 мин) →
      // ceil(200*1420/1440)=198, порции по 2–3 карточки.
      expect(total).toBe(198);
      expect(total).toBeLessThanOrEqual(200);
      expect(maxPerCycle).toBeLessThanOrEqual(AUTO_DELIVER_PER_CYCLE);
    });

    it('маленькие dailyLimit не залипают в нуле: 1 → максимум 1 в сутки, 2 → 2', async () => {
      const dayStart = Date.parse('2026-09-18T21:00:00Z');
      const runDay = async (dailyLimit: number): Promise<number> => {
        clockNow = new Date(dayStart);
        const { service, observedRepo, registry, delivery } = setup({ settings: { dailyLimit } });
        const pool = Array.from({ length: 6 }, (_, i) =>
          scoredRow({ id: i + 1, sourceChatId: `-100s${i}`, mediaUniqueId: `m-${i}` })
        );
        const chatIds = Array.from({ length: 6 }, (_, i) => `-100s${i}`);
        registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
        const deliveredToday: any[] = [];
        observedRepo.count.mockImplementation(async ({ where }: any) =>
          where?.forced === false ? deliveredToday.length : 0
        );
        observedRepo.find.mockImplementation(async ({ where }: any) =>
          where?.forced === false ? pool : []
        );
        delivery.deliver.mockImplementation(async (row: any) => {
          deliveredToday.push(row);
          return { ok: true, status: ObservedStatus.DELIVERED };
        });

        let total = 0;
        for (let minute = 0; minute < 24 * 60; minute += 20) {
          clockNow = new Date(dayStart + minute * 60_000);
          total += await service.deliverDue();
        }
        return total;
      };

      // Раньше floor(...) давал 0 весь день для лимитов 1–2.
      expect(await runDay(1)).toBe(1);
      expect(await runDay(2)).toBe(2);
    });

    it('разгон масштабируется под dailyLimit и время суток (00:00 → 0, 00:30 → 1, 01:00 → 2, 06:00 → 5)', async () => {
      const { service, observedRepo } = setup({ settings: { dailyLimit: 48 } });
      observedRepo.count.mockResolvedValue(0);
      const quotaAt = async (iso: string): Promise<number> => {
        clockNow = new Date(iso);
        return service.remainingQuota();
      };

      expect(await quotaAt('2026-09-18T21:00:00Z')).toBe(0); // 00:00 MSK → allowed 0
      expect(await quotaAt('2026-09-18T21:30:00Z')).toBe(1); // 00:30 MSK → allowed 1
      expect(await quotaAt('2026-09-18T22:00:00Z')).toBe(2); // 01:00 MSK → allowed 2
      expect(await quotaAt('2026-09-19T00:00:00Z')).toBe(5); // 03:00 MSK → allowed 6, кап 5
      expect(await quotaAt('2026-09-19T03:00:00Z')).toBe(5); // 06:00 MSK → allowed 12, кап 5
    });

    it('разгон dailyLimit=200: 00:00 → 0, 00:15 → 3, 00:30 → кап 5, 01:00 → кап 5', async () => {
      const { service, observedRepo } = setup({ settings: { dailyLimit: 200 } });
      observedRepo.count.mockResolvedValue(0);
      const quotaAt = async (iso: string): Promise<number> => {
        clockNow = new Date(iso);
        return service.remainingQuota();
      };

      expect(await quotaAt('2026-09-18T21:00:00Z')).toBe(0); // 00:00 MSK
      expect(await quotaAt('2026-09-18T21:15:00Z')).toBe(3); // 00:15 MSK → ceil(2.08)
      expect(await quotaAt('2026-09-18T21:30:00Z')).toBe(5); // 00:30 MSK → ceil(4.17), кап 5
      expect(await quotaAt('2026-09-18T22:00:00Z')).toBe(5); // 01:00 MSK → ceil(8.33), кап 5
    });

    it('догон после пропуска: далеко догнавший разгон режется порцией AUTO_DELIVER_PER_CYCLE', async () => {
      // 12:00 MSK = 09:00Z → allowed floor(200*12/24)=100, отдано 40 → остаток 60.
      clockNow = new Date('2026-09-19T09:00:00Z');
      const { service, observedRepo, registry, delivery } = setup({
        settings: { dailyLimit: 200 },
      });
      observedRepo.count.mockResolvedValue(40);
      const chatIds = Array.from({ length: 10 }, (_, i) => `-1000${i}`);
      observedRepo.find.mockResolvedValue(
        chatIds.map((chatId, i) =>
          scoredRow({ id: i + 1, sourceChatId: chatId, mediaUniqueId: `m-${i}` })
        )
      );
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.remainingQuota()).toBe(AUTO_DELIVER_PER_CYCLE);
      // Остаток разгона 60, но за один цикл — не больше порции.
      expect(await service.deliverDue(50)).toBe(AUTO_DELIVER_PER_CYCLE);
      expect(delivery.deliver).toHaveBeenCalledTimes(AUTO_DELIVER_PER_CYCLE);
    });

    it('очередь выше старого порога 400, но ниже аварийного — нормальные посты всё равно уходят', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.count.mockResolvedValueOnce(QUEUE_EMERGENCY_CAP - 1).mockResolvedValue(0);
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
    });

    it('дедуп в выдаче: при одном медиа остаётся кандидат с большим рангом', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 1, mediaUniqueId: 'same-media', score: 9, createdAt: daysAgo(3) }),
        scoredRow({ id: 2, mediaUniqueId: 'same-media', score: 2, createdAt: NOW }),
      ]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.deliverDue()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    it('ранг = score × вес источника: меньший скор из сильного канала идёт выше', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      const strongChat = '-100strong';
      const plainChat = '-100plain';
      // score DESC, как отдал бы реальный запрос: plain (9) впереди strong (5).
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 2, sourceChatId: plainChat, mediaUniqueId: 'b', score: 9 }),
        scoredRow({ id: 1, sourceChatId: strongChat, mediaUniqueId: 'a', score: 5 }),
      ]);
      registry.repository.find.mockResolvedValue([
        // Взятия свежие → буст полный: weight = 1 + min(2, log2(4)) = 3.
        source({ chatId: strongChat, takenTotal: 3, lastTakenAt: NOW }),
        source({ chatId: plainChat, takenTotal: 0 }),
      ]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      await service.deliverDue();

      // strong: 5 × 3 = 15; plain: 9 × 1 = 9 → strong первым.
      expect(delivery.deliver.mock.calls[0][0].id).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(2);
    });
  });

  describe('pickDiverse', () => {
    const pick = (service: ParserSelectorService, rows: any[], limit: number): any[] =>
      (service as never as { pickDiverse: (r: any[], l: number) => any[] }).pickDiverse(rows, limit);

    it('не более DUMP_PER_SOURCE_CAP постов одного источника, остаток из других', () => {
      const { service } = setup();
      const rows = [
        scoredRow({ id: 1, sourceChatId: '-100A' }),
        scoredRow({ id: 2, sourceChatId: '-100A' }),
        scoredRow({ id: 3, sourceChatId: '-100A' }),
        scoredRow({ id: 4, sourceChatId: '-100B' }),
        scoredRow({ id: 5, sourceChatId: '-100C' }),
        scoredRow({ id: 6, sourceChatId: '-100A' }),
        scoredRow({ id: 7, sourceChatId: '-100A' }),
        scoredRow({ id: 8, sourceChatId: '-100A' }),
      ];

      const picked = pick(service, rows, 5);

      expect(picked.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
      expect(picked.filter((row) => row.sourceChatId === '-100A')).toHaveLength(DUMP_PER_SOURCE_CAP);
    });

    it('кап строгий: больше 3 с одного источника не берём даже недобрав limit', () => {
      const { service } = setup();
      const rows = [
        scoredRow({ id: 1, sourceChatId: '-100A' }),
        scoredRow({ id: 2, sourceChatId: '-100A' }),
        scoredRow({ id: 3, sourceChatId: '-100A' }),
        scoredRow({ id: 4, sourceChatId: '-100A' }),
        scoredRow({ id: 5, sourceChatId: '-100A' }),
        scoredRow({ id: 6, sourceChatId: '-100A' }),
      ];

      const picked = pick(service, rows, 5);

      expect(picked).toHaveLength(3);
      expect(picked.map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('кандидатов меньше limit — отдаёт всё', () => {
      const { service } = setup();
      const rows = [scoredRow({ id: 1 }), scoredRow({ id: 2 })];
      expect(pick(service, rows, 5)).toHaveLength(2);
    });

    it('останавливается, когда limit уже набран', () => {
      const { service } = setup();
      const rows = [
        scoredRow({ id: 1, sourceChatId: '-100A' }),
        scoredRow({ id: 2, sourceChatId: '-100A' }),
        scoredRow({ id: 3, sourceChatId: '-100A' }),
        scoredRow({ id: 4, sourceChatId: '-100B' }),
        scoredRow({ id: 5, sourceChatId: '-100C' }),
      ];

      const picked = pick(service, rows, 3);

      expect(picked.map((row) => row.id)).toEqual([1, 2, 3]);
    });
  });

  describe('ageBacklog', () => {
    it('карточки старше 7д удаляются и мягко игнорируются', async () => {
      const { service, observedRepo, registry, bot } = setup();
      const card = scoredRow({
        id: 1,
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: 321,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) => {
        if (where.status === ObservedStatus.DELIVERED) return [card];
        return [];
      });

      expect(await service.ageBacklog()).toBe(1);
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(-1004444444444, 321);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.EXPIRED, rejectReason: `backlog-${BACKLOG_TTL_DAYS}d` })
      );
      expect(registry.markSourceIgnored).toHaveBeenCalledWith('-1008888888888', false);
    });

    it('оценённый пул старше 14д истекает', async () => {
      const { service, observedRepo } = setup();
      const poolRow = scoredRow({ id: 2, createdAt: daysAgo(POOL_TTL_DAYS + 1) });
      observedRepo.find.mockImplementation(async ({ where }: any) => {
        if (where.status === ObservedStatus.SCORED) return [poolRow];
        return [];
      });

      expect(await service.ageBacklog()).toBe(1);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.EXPIRED, rejectReason: `pool-${POOL_TTL_DAYS}d` })
      );
    });

    it('карточка без сообщения удаляется без вызова deleteMessage', async () => {
      const { service, observedRepo, bot } = setup();
      const card = scoredRow({
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: null,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.DELIVERED ? [card] : []
      );

      await service.ageBacklog();
      expect(bot.api.deleteMessage).not.toHaveBeenCalled();
    });

    it('ошибка удаления сообщения не роняет старение', async () => {
      const { service, observedRepo, bot } = setup();
      const card = scoredRow({
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: 321,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.DELIVERED ? [card] : []
      );
      bot.api.deleteMessage.mockRejectedValue(new Error('gone'));

      await expect(service.ageBacklog()).resolves.toBe(1);
      expect(bot.api.editMessageCaption).toHaveBeenCalledWith(
        -1004444444444,
        321,
        expect.objectContaining({ caption: expect.stringContaining('Состарилось') })
      );
    });

    it('если и удаление, и пометка карточки упали — старение не падает', async () => {
      const { service, observedRepo, bot } = setup();
      const card = scoredRow({
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: 321,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.DELIVERED ? [card] : []
      );
      bot.api.deleteMessage.mockRejectedValue(new Error('gone'));
      bot.api.editMessageCaption.mockRejectedValue(new Error('cannot edit'));

      await expect(service.ageBacklog()).resolves.toBe(1);
    });

    it('зависшие SELECTED без message_id возвращаются в SCORED', async () => {
      const { service, observedRepo } = setup();
      const stuck = scoredRow({
        id: 7,
        status: ObservedStatus.SELECTED,
        requestChannelMessageId: null,
        updatedAt: new Date(NOW.getTime() - 2 * 3_600_000),
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.SELECTED ? [stuck] : []
      );

      expect(await service.ageBacklog()).toBe(0);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7, status: ObservedStatus.SCORED })
      );
    });

  });

  it('pace реально ждёт (без подмены)', async () => {
    const { service } = setup();
    delete (service as never as { pace?: unknown }).pace;
    await expect((service as never as { pace: (ms: number) => Promise<void> }).pace(0)).resolves.toBeUndefined();
  });

  it('countBacklog считает DELIVERED', async () => {
    const { service, observedRepo } = setup();
    observedRepo.count.mockResolvedValue(4);
    expect(await service.countBacklog()).toBe(4);
    expect(observedRepo.count).toHaveBeenCalledWith({ where: { status: ObservedStatus.DELIVERED } });
  });

  it('startOfToday считает начало суток в Europe/Moscow', () => {
    const { service } = setup();
    const start = (service as never as { startOfToday: (now: Date) => Date }).startOfToday(NOW);
    expect(start.toISOString()).toBe('2026-09-18T21:00:00.000Z');
  });

  it('граница суток MSK: ровно полночь = начало этих же суток, квота 0', async () => {
    clockNow = new Date('2026-09-18T21:00:00Z'); // 2026-09-19 00:00 MSK
    const { service, observedRepo } = setup({ settings: { dailyLimit: 200 } });
    observedRepo.count.mockResolvedValue(0);

    expect(
      (service as never as { startOfToday: (now: Date) => Date }).startOfToday(clockNow).toISOString()
    ).toBe('2026-09-18T21:00:00.000Z');
    expect(await service.remainingQuota()).toBe(0);
  });

  it('граница суток MSK: за секунду до полуночи относится к предыдущим суткам', () => {
    const { service } = setup();
    const start = (service as never as { startOfToday: (now: Date) => Date }).startOfToday(
      new Date('2026-09-18T20:59:59Z') // 2026-09-18 23:59:59 MSK
    );
    expect(start.toISOString()).toBe('2026-09-17T21:00:00.000Z');
  });

  it('граница суток MSK: полдень MSK (09:00Z) → начало суток 21:00Z предыдущего дня', () => {
    const { service } = setup();
    const start = (service as never as { startOfToday: (now: Date) => Date }).startOfToday(
      new Date('2026-09-19T09:00:00Z')
    );
    expect(start.toISOString()).toBe('2026-09-18T21:00:00.000Z');
  });

  it('deliverRows: источник отсутствует → кандидат отклоняется', async () => {
    const { service, observedRepo, delivery } = setup();
    const row = scoredRow();

    await (service as never as { deliverRows: (...args: unknown[]) => Promise<number> }).deliverRows([row], new Map(), false);

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'source-missing' })
    );
  });
});
