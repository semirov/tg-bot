import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BaseConfigService } from '../../config/base-config.service';
import { TROLL_SETTINGS_ID } from '../constants/troll-limits';
import { TrollSettingsEntity } from '../entities/troll-settings.entity';
import { TrollRuntimeSettings } from '../interfaces/troll.interface';

/**
 * Хранилище настраиваемых параметров тролль-бота.
 *
 * Значения лежат в БД одной строкой (id = 1) и кэшируются в памяти, т.к.
 * читаются на каждое сообщение. Изменения из админки пишутся в БД и сразу
 * обновляют кэш. Кэш рассчитан на один инстанс: при нескольких репликах
 * изменения подхватятся только после перезапуска или вызова refresh().
 */
@Injectable()
export class TrollSettingsService implements OnModuleInit {
  private readonly logger = new Logger(TrollSettingsService.name);
  private cached: TrollRuntimeSettings;

  constructor(
    @InjectRepository(TrollSettingsEntity)
    private readonly repository: Repository<TrollSettingsEntity>,
    private readonly config: BaseConfigService
  ) {
    // Значения по умолчанию доступны синхронно ещё до загрузки из БД.
    this.cached = this.buildDefaults();
  }

  public async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Текущие настройки (из кэша, синхронно). */
  public get current(): TrollRuntimeSettings {
    return this.cached;
  }

  /** Перечитывает настройки из БД. При отсутствии строки — дефолты из env. */
  public async refresh(): Promise<TrollRuntimeSettings> {
    try {
      const row = await this.repository.findOne({ where: { id: TROLL_SETTINGS_ID } });
      this.cached = row ? this.fromRow(row) : this.buildDefaults();
    } catch (error) {
      this.logger.error(`Failed to load troll settings, using defaults: ${this.describeError(error)}`);
      this.cached = this.buildDefaults();
    }
    return this.cached;
  }

  /** Частично обновляет настройки и сохраняет их в БД. */
  public async update(patch: Partial<TrollRuntimeSettings>): Promise<TrollRuntimeSettings> {
    const next: TrollRuntimeSettings = { ...this.cached, ...patch };
    this.cached = next;

    try {
      await this.repository.save({
        id: TROLL_SETTINGS_ID,
        ...next,
        updatedAt: new Date(),
      });
    } catch (error) {
      this.logger.error(`Failed to persist troll settings: ${this.describeError(error)}`);
    }

    return next;
  }

  /** Сбрасывает настройки к значениям по умолчанию. */
  public async reset(): Promise<TrollRuntimeSettings> {
    return this.update(this.buildDefaults());
  }

  private buildDefaults(): TrollRuntimeSettings {
    return {
      enabled: true,
      criminalEnabled: true,
      criminalThreshold: this.config.trollCriminalThreshold,
      criminalHighThreshold: this.config.trollCriminalHighThreshold,
      sarcasmEnabled: true,
      sarcasmChance: this.config.trollSarcasmChance,
      sarcasmCooldownSec: this.config.trollSarcasmCooldown,
      mirrorEnabled: true,
      mirrorChance: this.config.trollMirrorChance,
      mirrorCooldownSec: this.config.trollMirrorCooldown,
      reactionEnabled: true,
      reactionChance: this.config.trollReactionChance,
      reactionCooldownSec: this.config.trollReactionCooldown,
      jerkEnabled: true,
      addressReactionEnabled: true,
      jerkBatchWindowSec: this.config.trollJerkBatchWindow,
      jerkCooldownSec: this.config.trollJerkCooldown,
      dialogPauseMin: this.config.trollDialogPauseMin,
      analyzeCooldownSec: this.config.trollAnalyzeCooldown,
      dailyRequestLimit: this.config.trollDailyRequestLimit,
      maxInputChars: this.config.trollMaxInputChars,
      selfCheckEnabled: true,
      selfCheckThreshold: this.config.trollSelfCheckThreshold,
      memberTagsEnabled: true,
      memberBioEnabled: true,
      visionEnabled: true,
      useProModel: true,
    };
  }

  private fromRow(row: TrollSettingsEntity): TrollRuntimeSettings {
    const defaults = this.buildDefaults();
    return {
      enabled: row.enabled ?? defaults.enabled,
      criminalEnabled: row.criminalEnabled ?? defaults.criminalEnabled,
      criminalThreshold: this.normalizeProbability(row.criminalThreshold, defaults.criminalThreshold),
      criminalHighThreshold: this.normalizeProbability(
        row.criminalHighThreshold,
        defaults.criminalHighThreshold
      ),
      sarcasmEnabled: row.sarcasmEnabled ?? defaults.sarcasmEnabled,
      sarcasmChance: this.normalizeProbability(row.sarcasmChance, defaults.sarcasmChance),
      sarcasmCooldownSec: this.normalizeNonNegativeInt(
        row.sarcasmCooldownSec,
        defaults.sarcasmCooldownSec
      ),
      mirrorEnabled: row.mirrorEnabled ?? defaults.mirrorEnabled,
      mirrorChance: this.normalizeProbability(row.mirrorChance, defaults.mirrorChance),
      mirrorCooldownSec: this.normalizeNonNegativeInt(
        row.mirrorCooldownSec,
        defaults.mirrorCooldownSec
      ),
      reactionEnabled: row.reactionEnabled ?? defaults.reactionEnabled,
      reactionChance: this.normalizeProbability(row.reactionChance, defaults.reactionChance),
      reactionCooldownSec: this.normalizeNonNegativeInt(
        row.reactionCooldownSec,
        defaults.reactionCooldownSec
      ),
      jerkEnabled: row.jerkEnabled ?? defaults.jerkEnabled,
      addressReactionEnabled: row.addressReactionEnabled ?? defaults.addressReactionEnabled,
      jerkBatchWindowSec: this.normalizeNonNegativeInt(
        row.jerkBatchWindowSec,
        defaults.jerkBatchWindowSec
      ),
      jerkCooldownSec: this.normalizeNonNegativeInt(row.jerkCooldownSec, defaults.jerkCooldownSec),
      dialogPauseMin: this.normalizeNonNegativeInt(row.dialogPauseMin, defaults.dialogPauseMin),
      analyzeCooldownSec: this.normalizeNonNegativeInt(
        row.analyzeCooldownSec,
        defaults.analyzeCooldownSec
      ),
      dailyRequestLimit: this.normalizeNonNegativeInt(
        row.dailyRequestLimit,
        defaults.dailyRequestLimit
      ),
      maxInputChars: this.normalizeNonNegativeInt(row.maxInputChars, defaults.maxInputChars),
      selfCheckEnabled: row.selfCheckEnabled ?? defaults.selfCheckEnabled,
      selfCheckThreshold: this.normalizeProbability(
        row.selfCheckThreshold,
        defaults.selfCheckThreshold
      ),
      memberTagsEnabled: row.memberTagsEnabled ?? defaults.memberTagsEnabled,
      memberBioEnabled: row.memberBioEnabled ?? defaults.memberBioEnabled,
      visionEnabled: row.visionEnabled ?? defaults.visionEnabled,
      useProModel: row.useProModel ?? defaults.useProModel,
    };
  }

  private normalizeProbability(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(0, Math.min(1, parsed));
  }

  private normalizeNonNegativeInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
