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
  it('без строки в БД — дефолты (singleton-паттерн настроек)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const service = new ParserSettingsService(repo, makeConfig());

    await service.onModuleInit();
    expect(service.current.dailyLimit).toBe(200);
    expect(service.current.sourceDailyCap).toBe(10);
    expect(service.current.minViews).toBe(40);
    expect(service.current.minReactions).toBe(0);
    expect(service.current.nvMin).toBe(0.5);
    expect(service.current.nrMin).toBe(0.5);
    expect(service.current.hotScore).toBe(1);
    expect(service.current.cringeMinViews).toBe(20);
    expect(service.current.cringeShareMin).toBe(0.03);
    expect(service.current.errMin).toBe(0.1);
    expect(service.current.evalPreHours).toBe(1);
    expect(service.current.evalFinalHours).toBe(6);
    expect(service.current.candidateTtlHours).toBe(96);
    expect(service.current.idlePruneDays).toBe(3);
    expect(service.current.refreshBatchSize).toBe(120);
    expect(service.current.refreshStaleHours).toBe(12);
    expect(service.current.forceRefreshWindowHours).toBe(168);
    expect(service.current.qualityVersion).toBe(3);
    expect(service.current.enabled).toBe(true);
    expect(service.current.boostUntil).toBeNull();
    expect(service.current.legacyEnabled).toBe(true);
    // Дефолты уже актуальной версии — adoption не пишет строку.
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('boost: boostActive учитывает boostUntil', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    const now = new Date('2026-09-19T12:00:00Z');
    expect(service.boostActive(now)).toBe(false);

    await service.update({ boostUntil: new Date(now.getTime() + 60_000).toISOString() });
    expect(service.boostActive(now)).toBe(true);

    await service.update({ boostUntil: new Date(now.getTime() - 60_000).toISOString() });
    expect(service.boostActive(now)).toBe(false);

    await service.update({ boostUntil: 'не-дата' });
    expect(service.boostActive(now)).toBe(false);
  });

  it('legacyEnabled из БД попадает в кэш', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ legacyEnabled: false }));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();
    expect(service.current.legacyEnabled).toBe(false);
  });

  it('boostUntil из БД нормализуется в ISO', async () => {
    const repo = makeRepo();
    const boostUntil = new Date('2026-09-19T13:00:00Z');
    repo.findOne.mockResolvedValue(row({ boostUntil }));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();
    expect(service.current.boostUntil).toBe(boostUntil.toISOString());
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
    expect(service.current.dailyLimit).toBe(200);
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
    expect(service.current.dailyLimit).toBe(200);
    expect(service.current.minViews).toBe(40);
  });

  it('строка без qualityVersion (legacy) — расслабляется до v2 и получает дефолты выдачи v3', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(
      row({
        qualityVersion: 0,
        dailyLimit: 0,
        sourceDailyCap: 0,
        minViews: 500,
        minReactions: 5,
        nvMin: 1.5,
        nrMin: 2,
        hotScore: 4,
        cringeMinViews: 100,
        cringeShareMin: 0.2,
        errMin: 0.3,
        evalPreHours: 4,
        evalFinalHours: 24,
      })
    );
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.qualityVersion).toBe(3);
    expect(service.current.dailyLimit).toBe(200);
    expect(service.current.sourceDailyCap).toBe(10);
    expect(service.current.minViews).toBe(40);
    expect(service.current.minReactions).toBe(0);
    expect(service.current.nvMin).toBe(0.5);
    expect(service.current.nrMin).toBe(0.5);
    expect(service.current.hotScore).toBe(1);
    expect(service.current.cringeMinViews).toBe(20);
    expect(service.current.cringeShareMin).toBe(0.03);
    expect(service.current.errMin).toBe(0.1);
    expect(service.current.evalPreHours).toBe(1);
    expect(service.current.evalFinalHours).toBe(6);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        qualityVersion: 3,
        errMin: 0.1,
        dailyLimit: 200,
        sourceDailyCap: 10,
      })
    );
  });

  it('adoption не ужесточает значения строже пресета', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(
      row({ qualityVersion: 1, minViews: 10, errMin: 0.05, evalFinalHours: 3 })
    );
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.minViews).toBe(10);
    expect(service.current.errMin).toBe(0.05);
    expect(service.current.evalFinalHours).toBe(3);
    expect(service.current.qualityVersion).toBe(3);
  });

  it('v2 → v3: нулевые legacy-значения поднимаются до дефолтов выдачи', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(
      row({
        qualityVersion: 2,
        dailyLimit: 0,
        sourceDailyCap: 0,
        refreshBatchSize: 0,
        refreshStaleHours: 0,
        forceRefreshWindowHours: 0,
        minViews: 500,
      })
    );
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.qualityVersion).toBe(3);
    expect(service.current.dailyLimit).toBe(200);
    expect(service.current.sourceDailyCap).toBe(10);
    expect(service.current.refreshBatchSize).toBe(120);
    expect(service.current.refreshStaleHours).toBe(12);
    expect(service.current.forceRefreshWindowHours).toBe(168);
    // Релакс-пресет v2 повторно не применяется.
    expect(service.current.minViews).toBe(500);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        qualityVersion: 3,
        dailyLimit: 200,
        sourceDailyCap: 10,
        refreshBatchSize: 120,
      })
    );
  });

  it('v2 → v3: положительные владельческие значения сохраняются', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(
      row({
        qualityVersion: 2,
        dailyLimit: 50,
        sourceDailyCap: 4,
        refreshBatchSize: 30,
        refreshStaleHours: 6,
        forceRefreshWindowHours: 72,
      })
    );
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.dailyLimit).toBe(50);
    expect(service.current.sourceDailyCap).toBe(4);
    expect(service.current.refreshBatchSize).toBe(30);
    expect(service.current.refreshStaleHours).toBe(6);
    expect(service.current.forceRefreshWindowHours).toBe(72);
    expect(service.current.qualityVersion).toBe(3);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, qualityVersion: 3, dailyLimit: 50, sourceDailyCap: 4 })
    );
  });

  it('строка с qualityVersion = 3 не мигрируется повторно', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ qualityVersion: 3, minViews: 500 }));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.minViews).toBe(500);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('after adoption owner edits persist (версия 3 дальше)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ qualityVersion: 0, minViews: 500 }));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();
    repo.save.mockClear();

    await service.update({ minViews: 500 });

    expect(service.current.minViews).toBe(500);
    expect(service.current.qualityVersion).toBe(3);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ minViews: 500, qualityVersion: 3 })
    );
  });

  it('ошибка сохранения adoption не роняет и оставляет кэш расслабленным', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(row({ qualityVersion: 0, minViews: 500 }));
    repo.save.mockRejectedValue(new Error('db down'));
    const service = new ParserSettingsService(repo, makeConfig());

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.current.minViews).toBe(40);
    expect(service.current.qualityVersion).toBe(3);
  });

  it('ошибка сохранения update не роняет, кэш обновляется', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockRejectedValue(new Error('db down'));
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    await expect(service.update({ dailyLimit: 7 })).resolves.toMatchObject({ dailyLimit: 7 });
    expect(service.current.dailyLimit).toBe(7);
  });

  it('некорректные значения из БД отсекаются', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(
      row({ dailyLimit: -5, sourceDailyCap: 0, cringeShare: 5, evalFinalHours: 1 })
    );
    const service = new ParserSettingsService(repo, makeConfig());
    await service.onModuleInit();

    expect(service.current.dailyLimit).toBe(200);
    expect(service.current.cringeShare).toBeLessThanOrEqual(1);
    expect(service.current.evalFinalHours).toBeGreaterThanOrEqual(2);
    expect(service.current.sourceDailyCap).toBe(10);
  });
});
