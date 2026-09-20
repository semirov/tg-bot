import { PARSER_SETTINGS_ID } from '../constants/parser.constants';
import { ParserSettingsService } from './parser-settings.service';

const makeRepo = (): any => ({
  findOne: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
});

const makeConfig = (overrides: Record<string, unknown> = {}): any => ({
  parserEnabled: true,
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({ id: PARSER_SETTINGS_ID, ...overrides });

describe('ParserSettingsService', () => {
  it('без строки в БД — дефолты (клон TrollSettings-паттерна)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const service = new ParserSettingsService(repo, makeConfig());

    await service.onModuleInit();
    expect(service.current.dailyLimit).toBe(12);
    expect(service.current.sourceDailyCap).toBe(2);
    expect(service.current.enabled).toBe(true);
  });

  it('строка в БД перекрывает дефолты', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ dailyLimit: 20, cringeShare: 0.5, aiEnabled: true }));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.dailyLimit).toBe(20);
    expect(service.current.cringeShare).toBe(0.5);
    expect(service.current.aiEnabled).toBe(true);
  });

  it('env-выключатель перекрывает БД', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ enabled: true }));
    const service = new ParserSettingsService(repo, makeConfig({ parserEnabled: false }));
    await service.onModuleInit();

    expect(service.enabled).toBe(false);
  });

  it('enabled = db.enabled && env', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ enabled: false }));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.enabled).toBe(false);
  });

  it('ошибка БД → дефолты, не падаем', async () => {
    const repo = makeRepo();
    repo.findOne.mockRejectedValue(new Error('db down'));
    const service = new ParserSettingsService(repo, makeConfig());
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.current.dailyLimit).toBe(12);
  });

  it('update сохраняет в БД и в кэш; сброс возвращает дефолты', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    await service.update({ dailyLimit: 15, minViews: 500 });
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 1, dailyLimit: 15, minViews: 500 }));
    expect(service.current.dailyLimit).toBe(15);

    await service.reset();
    expect(service.current.dailyLimit).toBe(12);
    expect(service.current.minViews).toBe(200);
  });

  it('некорректные значения из БД отсекаются', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(
      row({ dailyLimit: -5, sourceDailyCap: 0, cringeShare: 5, evalFinalHours: 1 })
    );
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.dailyLimit).toBe(12);
    expect(service.current.cringeShare).toBeLessThanOrEqual(1);
    expect(service.current.evalFinalHours).toBeGreaterThanOrEqual(2);
    expect(service.current.sourceDailyCap).toBeGreaterThanOrEqual(1);
  });
});
