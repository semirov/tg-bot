import { EvalStage, ObservedStatus } from '../constants/parser.constants';
import { ParserSelectorService } from './parser-selector.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const NOW = new Date('2026-09-19T12:00:00Z');

const scoredRow = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  sourceChatId: '-1008888888888',
  mediaUniqueId: 'media-1',
  score: 5,
  evalStage: EvalStage.FINAL,
  status: ObservedStatus.SCORED,
  createdAt: NOW,
  ...overrides,
});

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1008888888888',
  category: 'memes',
  status: 'active',
  selectedTotal: 0,
  ...overrides,
});

const makeObservedRepo = (): any => {
  const builder: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  return {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (value) => value),
    createQueryBuilder: jest.fn(() => builder),
  };
};

const makeRegistry = (): any => ({
  repository: {
    find: jest.fn().mockResolvedValue([source()]),
    save: jest.fn().mockResolvedValue(undefined),
  },
});

const makeEvaluator = (): any => ({ isEligible: jest.fn(() => true) });

const makeDelivery = (): any => ({
  deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }),
});

const makeSettings = (overrides: Record<string, unknown> = {}): any => ({
  current: { dailyLimit: 12, sourceDailyCap: 2, cringeShare: 0.25, hotScore: 4, ...overrides },
  enabled: true,
});

const makeClock = (): any => ({ now: jest.fn(() => NOW) });

const setup = (overrides: { settings?: Record<string, unknown>; eligible?: boolean } = {}) => {
  const observedRepo = makeObservedRepo();
  const registry = makeRegistry();
  const evaluator = makeEvaluator();
  evaluator.isEligible.mockReturnValue(overrides.eligible ?? true);
  const delivery = makeDelivery();
  const service = new ParserSelectorService(
    observedRepo,
    registry,
    evaluator,
    delivery,
    makeSettings(overrides.settings ?? {}),
    makeClock()
  );
  const setDue = (rows: unknown[]): void => {
    observedRepo.find.mockImplementation((options: { where?: Record<string, unknown> } = {}) => {
      if (options.where?.mediaUniqueId !== undefined) return Promise.resolve([]);
      return Promise.resolve(rows);
    });
  };
  return { service, observedRepo, registry, delivery, evaluator, setDue };
};

describe('ParserSelectorService', () => {
  it('нет кандидатов → 0 доставок', async () => {
    const { service, observedRepo } = setup();
    observedRepo.find.mockResolvedValue([]);

    expect(await service.selectAndDeliver()).toBe(0);
  });

  it('выключен конвейер → 0', async () => {
    const { service, delivery } = setup({ settings: { enabled: false } as never });
    (service as never as { settings: { enabled: boolean } }).settings.enabled = false;

    expect(await service.selectAndDeliver()).toBe(0);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('доставляет отобранного и переводит в DELIVERED', async () => {
    const { service, delivery, setDue } = setup();
    setDue([scoredRow()]);

    const delivered = await service.selectAndDeliver();

    expect(delivered).toBe(1);
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('невозможно доставить из-за сбоя → возврат в SCORED', async () => {
    const { service, observedRepo, delivery, setDue } = setup();
    setDue([scoredRow()]);
    delivery.deliver.mockResolvedValue({ ok: false, status: ObservedStatus.FAILED });

    expect(await service.selectAndDeliver()).toBe(0);
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: ObservedStatus.SCORED })
    );
  });

  it('источник не найден → REJECTED source-missing', async () => {
    const { service, registry, observedRepo, setDue } = setup();
    registry.repository.find.mockResolvedValue([]);
    setDue([scoredRow()]);

    await service.selectAndDeliver();

    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'source-missing' })
    );
  });

  it('дневной лимит исчерпан → доставки нет', async () => {
    const { service, delivery, observedRepo, setDue } = setup({ settings: { dailyLimit: 1 } });
    setDue([scoredRow()]);
    observedRepo.createQueryBuilder().getMany.mockResolvedValue([
      { sourceChatId: '-1008888888888', deliveredAt: NOW, status: ObservedStatus.DELIVERED },
    ]);

    expect(await service.selectAndDeliver()).toBe(0);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('квота источника за сегодня: второй пост того же канала пропускается', async () => {
    const { service, delivery, setDue } = setup({ settings: { sourceDailyCap: 1 } });
    setDue([
      scoredRow({ id: 1, mediaUniqueId: 'm1', score: 9 }),
      scoredRow({ id: 2, mediaUniqueId: 'm2', score: 8 }),
    ]);

    await service.selectAndDeliver();

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('дедуп внутри батча: одинаковые mediaUniqueId → один лучший', async () => {
    const { service, delivery, setDue } = setup();
    setDue([
      scoredRow({ id: 1, mediaUniqueId: 'dup', score: 3 }),
      scoredRow({ id: 2, mediaUniqueId: 'dup', score: 7 }),
    ]);

    await service.selectAndDeliver();

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  it('кросс-прогонный дедуп: уже доставленное медиа пропускается', async () => {
    const { service, delivery, observedRepo } = setup();
    observedRepo.find.mockImplementation((options: { where?: Record<string, unknown> } = {}) => {
      if (options.where?.mediaUniqueId !== undefined) {
        return Promise.resolve([{ mediaUniqueId: 'media-1', status: ObservedStatus.PUBLISHED }]);
      }
      return Promise.resolve([scoredRow()]);
    });

    await service.selectAndDeliver();

    expect(delivery.deliver).not.toHaveBeenCalled();
  });
});
