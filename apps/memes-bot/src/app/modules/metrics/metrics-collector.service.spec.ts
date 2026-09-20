import { metrics } from '../../shared/metrics';
import { MetricsCollectorService } from './metrics-collector.service';

const makeQueryBuilder = (rows: Array<{ status: string; count: string }>) => ({
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  getRawMany: jest.fn().mockResolvedValue(rows),
});

const makeRepos = (rows: Array<{ status: string; count: string }> = []) => {
  const qb = makeQueryBuilder(rows);
  return {
    qb,
    sources: { createQueryBuilder: jest.fn(() => qb), count: jest.fn() },
    candidates: { createQueryBuilder: jest.fn(() => qb), count: jest.fn() },
    observatory: { createQueryBuilder: jest.fn(() => qb), count: jest.fn().mockResolvedValue(4) },
    scheduler: { createQueryBuilder: jest.fn(() => qb), count: jest.fn().mockResolvedValue(2) },
    users: { createQueryBuilder: jest.fn(() => qb), count: jest.fn().mockResolvedValue(7) },
  };
};

const makeService = (repos: ReturnType<typeof makeRepos>) =>
  new MetricsCollectorService(
    repos.sources as never,
    repos.candidates as never,
    repos.observatory as never,
    repos.scheduler as never,
    repos.users as never
  );

describe('MetricsCollectorService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('collect проставляет бизнес-гейджи из БД', async () => {
    const repos = makeRepos([{ status: 'active', count: '3' }]);
    const service = makeService(repos);
    const sourcesSet = jest.spyOn(metrics.parser.sourcesByStatus, 'set');
    const candidatesSet = jest.spyOn(metrics.parser.candidatesByStatus, 'set');
    const pendingSet = jest.spyOn(metrics.observatory.pending, 'set');
    const scheduledSet = jest.spyOn(metrics.observatory.scheduledPending, 'set');
    const usersSet = jest.spyOn(metrics.users.total, 'set');

    await service.collect();

    expect(sourcesSet).toHaveBeenCalledWith({ status: 'active' }, 3);
    expect(candidatesSet).toHaveBeenCalledWith({ status: 'active' }, 3);
    expect(pendingSet).toHaveBeenCalledWith(4);
    expect(scheduledSet).toHaveBeenCalledWith(2);
    expect(usersSet).toHaveBeenCalledWith(7);
  });

  it('пустой результат группировки очищает старые метки', async () => {
    const repos = makeRepos([]);
    const service = makeService(repos);
    const reset = jest.spyOn(metrics.parser.sourcesByStatus, 'reset');
    await service.collect();
    expect(reset).toHaveBeenCalled();
  });

  it('onModuleInit регистрирует collect-колбэки гейджей', async () => {
    const repos = makeRepos([{ status: 'disabled', count: '1' }]);
    const service = makeService(repos);
    service.onModuleInit();

    const collect = (metrics.parser.sourcesByStatus as unknown as { collect?: () => Promise<void> })
      .collect;
    expect(collect).toBeDefined();
    await collect?.();
    expect(repos.sources.createQueryBuilder).toHaveBeenCalled();

    const pending = (metrics.observatory.pending as unknown as { collect?: () => Promise<void> })
      .collect;
    await pending?.();
    expect(repos.observatory.count).toHaveBeenCalled();
  });
});
