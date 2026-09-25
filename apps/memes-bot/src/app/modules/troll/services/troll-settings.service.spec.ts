import { Logger } from '@nestjs/common';
import { TrollSettingsService } from './troll-settings.service';
import { TROLL_SETTINGS_ID } from '../constants/troll-limits';

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    trollCriminalThreshold: 0.5,
    trollCriminalHighThreshold: 0.8,
    trollSarcasmChance: 0.05,
    trollSarcasmCooldown: 300,
    trollMirrorChance: 0.05,
    trollMirrorCooldown: 300,
    trollReactionChance: 0.05,
    trollReactionCooldown: 60,
    trollMemeAnnounceChance: 0.1,
    trollJerkBatchWindow: 15,
    trollJerkCooldown: 180,
    trollDialogPauseMin: 15,
    trollAnalyzeCooldown: 15,
    trollDailyRequestLimit: 2000,
    trollMaxInputChars: 1000,
    trollSelfCheckThreshold: 0.6,
    ...overrides,
  };
}

function makeRepo(): any {
  return {
    findOne: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(config: any = makeConfig(), repo: any = makeRepo()) {
  return { service: new TrollSettingsService(repo, config), repo };
}

describe('TrollSettingsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('дефолты', () => {
    it('отдаёт настройки из env синхронно, ещё до загрузки из БД', () => {
      const { service } = makeService(makeConfig({ trollSarcasmChance: 0.42 }));

      expect(service.current).toMatchObject({
        enabled: true,
        sarcasmChance: 0.42,
        criminalThreshold: 0.5,
        dailyRequestLimit: 2000,
        maxInputChars: 1000,
        selfCheckThreshold: 0.6,
      });
    });

    it('onModuleInit перечитывает настройки из БД', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue({ id: TROLL_SETTINGS_ID, dailyRequestLimit: 7 });
      const { service } = makeService(makeConfig(), repo);

      await service.onModuleInit();

      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: TROLL_SETTINGS_ID } });
      expect(service.current.dailyRequestLimit).toBe(7);
    });
  });

  describe('refresh', () => {
    it('нормализует строку из БД: клампы, floor, дефолты для null', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue({
        id: TROLL_SETTINGS_ID,
        enabled: false,
        criminalEnabled: undefined,
        criminalThreshold: 2,
        criminalHighThreshold: -1,
        sarcasmEnabled: true,
        sarcasmChance: 'abc',
        sarcasmCooldownSec: -5,
        mirrorEnabled: undefined,
        mirrorChance: 0.5,
        mirrorCooldownSec: 10.9,
        reactionEnabled: false,
        reactionChance: 1.5,
        reactionCooldownSec: '12',
        memeAnnounceEnabled: undefined,
        memeAnnounceChance: 0,
        jerkEnabled: false,
        addressReactionEnabled: undefined,
        jerkBatchWindowSec: 0,
        jerkCooldownSec: null,
        dialogPauseMin: 3.7,
        analyzeCooldownSec: 'x',
        dailyRequestLimit: 500.9,
        maxInputChars: -1,
        selfCheckEnabled: false,
        selfCheckThreshold: 0.6,
      });
      const { service } = makeService(makeConfig(), repo);

      const result = await service.refresh();

      expect(result).toEqual({
        enabled: false,
        criminalEnabled: true,
        criminalThreshold: 1,
        criminalHighThreshold: 0,
        sarcasmEnabled: true,
        sarcasmChance: 0.05,
        sarcasmCooldownSec: 300,
        mirrorEnabled: true,
        mirrorChance: 0.5,
        mirrorCooldownSec: 10,
        reactionEnabled: false,
        reactionChance: 1,
        reactionCooldownSec: 12,
        memeAnnounceEnabled: true,
        memeAnnounceChance: 0,
        jerkEnabled: false,
        addressReactionEnabled: true,
        jerkBatchWindowSec: 0,
        jerkCooldownSec: 0,
        dialogPauseMin: 3,
        analyzeCooldownSec: 15,
        dailyRequestLimit: 500,
        maxInputChars: 1000,
        selfCheckEnabled: false,
        selfCheckThreshold: 0.6,
        memberTagsEnabled: true,
        memberBioEnabled: true,
        visionEnabled: true,
        useProModel: true,
      });
      expect(service.current).toBe(result);
    });

    it('берёт из строки явно заданные булевы флаги', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue({
        id: TROLL_SETTINGS_ID,
        criminalEnabled: false,
        mirrorEnabled: false,
        memeAnnounceEnabled: false,
        addressReactionEnabled: false,
      });
      const { service } = makeService(makeConfig(), repo);

      const result = await service.refresh();

      expect(result.criminalEnabled).toBe(false);
      expect(result.mirrorEnabled).toBe(false);
      expect(result.memeAnnounceEnabled).toBe(false);
      expect(result.addressReactionEnabled).toBe(false);
    });

    it('при отсутствии строки берёт дефолты', async () => {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue(null);
      const { service } = makeService(makeConfig(), repo);

      const result = await service.refresh();

      expect(result.enabled).toBe(true);
      expect(result.dailyRequestLimit).toBe(2000);
    });

    it('при ошибке чтения логирует и берёт дефолты', async () => {
      const repo = makeRepo();
      repo.findOne.mockRejectedValue(new Error('db down'));
      const { service } = makeService(makeConfig(), repo);

      const result = await service.refresh();

      expect(result.enabled).toBe(true);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to load troll settings, using defaults: db down'
      );
    });

    it('разворачивает не-Error исключение при чтении', async () => {
      const repo = makeRepo();
      repo.findOne.mockRejectedValue('строка');
      const { service } = makeService(makeConfig(), repo);

      await service.refresh();

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to load troll settings, using defaults: строка'
      );
    });
  });

  describe('update', () => {
    it('мержит патч, сохраняет в БД с id и временем и возвращает новое состояние', async () => {
      const repo = makeRepo();
      const { service } = makeService(makeConfig(), repo);

      const result = await service.update({ sarcasmChance: 0.9 });

      expect(result.sarcasmChance).toBe(0.9);
      expect(result.maxInputChars).toBe(1000);
      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0];
      expect(saved).toMatchObject({ id: TROLL_SETTINGS_ID, sarcasmChance: 0.9, maxInputChars: 1000 });
      expect(saved.updatedAt).toBeInstanceOf(Date);
      expect(service.current).toBe(result);
    });

    it('при ошибке сохранения логирует, но возвращает обновлённое состояние', async () => {
      const repo = makeRepo();
      repo.save.mockRejectedValue(new Error('write failed'));
      const { service } = makeService(makeConfig(), repo);

      const result = await service.update({ enabled: false });

      expect(result.enabled).toBe(false);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to persist troll settings: write failed'
      );
    });

    it('разворачивает не-Error исключение при сохранении', async () => {
      const repo = makeRepo();
      repo.save.mockRejectedValue(42);
      const { service } = makeService(makeConfig(), repo);

      await service.update({ enabled: false });

      expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to persist troll settings: 42');
    });
  });

  describe('reset', () => {
    it('сбрасывает настройки к дефолтам и сохраняет их', async () => {
      const repo = makeRepo();
      const { service } = makeService(makeConfig(), repo);
      await service.update({ enabled: false, dailyRequestLimit: 1 });

      const result = await service.reset();

      expect(result.enabled).toBe(true);
      expect(result.dailyRequestLimit).toBe(2000);
      const saved = repo.save.mock.calls[repo.save.mock.calls.length - 1][0];
      expect(saved).toMatchObject({ id: TROLL_SETTINGS_ID, enabled: true, dailyRequestLimit: 2000 });
    });
  });
});
