import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BaseConfigService } from '../../config/base-config.service';
import { PARSER_SETTINGS_ID } from '../constants/parser.constants';
import { ParserSettingsEntity } from '../entities/parser-settings.entity';

/** Рантайм-настройки парсера (синхронное чтение кэша). */
export interface ParserRuntimeSettings {
  enabled: boolean;
  dailyLimit: number;
  sourceDailyCap: number;
  cringeShare: number;
  minViews: number;
  minReactions: number;
  nvMin: number;
  nrMin: number;
  posShareMin: number;
  hotScore: number;
  cringeShareMin: number;
  cringeMinViews: number;
  errMin: number;
  maxSources: number;
  evalPreHours: number;
  evalFinalHours: number;
  candidateTtlHours: number;
  idlePruneDays: number;
  aiEnabled: boolean;
  aiRelevanceMin: number;
  /** До какого времени действует boost «Насыпать ещё» (null — выключен). */
  boostUntil: string | null;
  /** Старый парсер (обсерватория) включён. */
  legacyEnabled: boolean;
  /** Версия набора порогов качества (см. `QUALITY_VERSION`). */
  qualityVersion: number;
}

/** Актуальная версия пресета качества; применяется к строке настроек при старте. */
const QUALITY_VERSION = 2;

/**
 * Целевой расслабленный пресет v2. Adoption применяет его как потолок
 * (`Math.min`): сохранённые более строгие значения опускаются до пресета,
 * уже более мягкие остаются как есть.
 */
const RELAXED_QUALITY_V2 = {
  minViews: 40,
  minReactions: 0,
  nvMin: 0.5,
  nrMin: 0.5,
  hotScore: 1,
  cringeMinViews: 20,
  cringeShareMin: 0.03,
  errMin: 0.1,
  evalPreHours: 1,
  evalFinalHours: 6,
} as const;

const clamp = (value: number, min: number, max: number, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const nonNegativeInt = (value: number | undefined | null, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

@Injectable()
export class ParserSettingsService implements OnModuleInit {
  private readonly logger = new Logger(ParserSettingsService.name);
  private cached: ParserRuntimeSettings = this.buildDefaults();

  constructor(
    @InjectRepository(ParserSettingsEntity)
    private readonly repository: Repository<ParserSettingsEntity>,
    private readonly config: BaseConfigService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    await this.adoptRelaxedDefaults();
  }

  /**
   * Разовая идемпотентная миграция строки настроек: при `qualityVersion < 2`
   * расслабляем пороги до пресета v2 (`Math.min` — потолок: сохранённые более
   * строгие значения опускаются до пресета, более мягкие не поднимаются),
   * сохраняем и поднимаем версию. После этого правки владельца сохраняются
   * как есть (версия уже 2).
   */
  private async adoptRelaxedDefaults(): Promise<void> {
    if (this.cached.qualityVersion >= QUALITY_VERSION) return;

    const next: ParserRuntimeSettings = {
      ...this.cached,
      qualityVersion: QUALITY_VERSION,
    };
    next.minViews = Math.min(next.minViews, RELAXED_QUALITY_V2.minViews);
    next.minReactions = Math.min(next.minReactions, RELAXED_QUALITY_V2.minReactions);
    next.nvMin = Math.min(next.nvMin, RELAXED_QUALITY_V2.nvMin);
    next.nrMin = Math.min(next.nrMin, RELAXED_QUALITY_V2.nrMin);
    next.hotScore = Math.min(next.hotScore, RELAXED_QUALITY_V2.hotScore);
    next.cringeMinViews = Math.min(next.cringeMinViews, RELAXED_QUALITY_V2.cringeMinViews);
    next.cringeShareMin = Math.min(next.cringeShareMin, RELAXED_QUALITY_V2.cringeShareMin);
    next.errMin = Math.min(next.errMin, RELAXED_QUALITY_V2.errMin);
    next.evalPreHours = Math.min(next.evalPreHours, RELAXED_QUALITY_V2.evalPreHours);
    next.evalFinalHours = Math.min(next.evalFinalHours, RELAXED_QUALITY_V2.evalFinalHours);

    this.cached = next;
    try {
      await this.repository.save({ id: PARSER_SETTINGS_ID, ...next, updatedAt: new Date() });
      this.logger.log(
        `Parser settings: relaxed quality preset v${QUALITY_VERSION} adopted`
      );
    } catch (error) {
      this.logger.error(`Не удалось применить relaxed-настройки парсера: ${error}`);
    }
  }

  get current(): ParserRuntimeSettings {
    return this.cached;
  }

  /** Мастер-выключатель: env-флаг перекрывает настройки в БД. */
  get enabled(): boolean {
    return this.config.parserEnabled && this.cached.enabled;
  }

  /** Активен ли разовый режим «Насыпать ещё». */
  public boostActive(now: Date = new Date()): boolean {
    if (!this.cached.boostUntil) return false;
    const until = new Date(this.cached.boostUntil).getTime();
    return Number.isFinite(until) && until > now.getTime();
  }

  async refresh(): Promise<ParserRuntimeSettings> {
    try {
      const row = await this.repository.findOne({ where: { id: PARSER_SETTINGS_ID } });
      this.cached = row ? this.fromRow(row) : this.buildDefaults();
    } catch (error) {
      this.logger.error(`Не удалось прочитать настройки парсера: ${error}`);
      this.cached = this.buildDefaults();
    }
    return this.cached;
  }

  async update(patch: Partial<ParserRuntimeSettings>): Promise<ParserRuntimeSettings> {
    const next = { ...this.cached, ...patch };
    this.cached = next;
    try {
      await this.repository.save({ id: PARSER_SETTINGS_ID, ...next, updatedAt: new Date() });
    } catch (error) {
      this.logger.error(`Не удалось сохранить настройки парсера: ${error}`);
    }
    return this.cached;
  }

  async reset(): Promise<ParserRuntimeSettings> {
    return this.update(this.buildDefaults());
  }

  buildDefaults(): ParserRuntimeSettings {
    return {
      enabled: true,
      dailyLimit: 0,
      sourceDailyCap: 0,
      cringeShare: clamp(0.25, 0, 1, 0.25),
      minViews: 40,
      minReactions: 0,
      nvMin: 0.5,
      nrMin: 0.5,
      posShareMin: clamp(0, 0, 1, 0),
      hotScore: 1,
      cringeShareMin: clamp(0.03, 0, 1, 0.03),
      cringeMinViews: 20,
      errMin: 0.1,
      maxSources: 40,
      evalPreHours: 1,
      evalFinalHours: 6,
      candidateTtlHours: 96,
      idlePruneDays: 3,
      aiEnabled: false,
      aiRelevanceMin: clamp(0.6, 0, 1, 0.6),
      boostUntil: null,
      legacyEnabled: true,
      qualityVersion: QUALITY_VERSION,
    };
  }

  private fromRow(row: ParserSettingsEntity): ParserRuntimeSettings {
    const defaults = this.buildDefaults();
    return {
      enabled: row.enabled ?? defaults.enabled,
      dailyLimit: nonNegativeInt(row.dailyLimit, defaults.dailyLimit),
      sourceDailyCap: nonNegativeInt(row.sourceDailyCap, defaults.sourceDailyCap),
      cringeShare: clamp(row.cringeShare, 0, 1, defaults.cringeShare),
      minViews: nonNegativeInt(row.minViews, defaults.minViews),
      minReactions: nonNegativeInt(row.minReactions, defaults.minReactions),
      nvMin: clamp(row.nvMin, 0.1, 100, defaults.nvMin),
      nrMin: clamp(row.nrMin, 0.1, 100, defaults.nrMin),
      posShareMin: clamp(row.posShareMin, 0, 1, defaults.posShareMin),
      hotScore: clamp(row.hotScore, 1, 100, defaults.hotScore),
      cringeShareMin: clamp(row.cringeShareMin, 0, 1, defaults.cringeShareMin),
      cringeMinViews: nonNegativeInt(row.cringeMinViews, defaults.cringeMinViews),
      errMin: clamp(row.errMin, 0, 1, defaults.errMin),
      maxSources: Math.max(1, nonNegativeInt(row.maxSources, defaults.maxSources)),
      evalPreHours: Math.max(1, nonNegativeInt(row.evalPreHours, defaults.evalPreHours)),
      evalFinalHours: Math.max(2, nonNegativeInt(row.evalFinalHours, defaults.evalFinalHours)),
      candidateTtlHours: Math.max(4, nonNegativeInt(row.candidateTtlHours, defaults.candidateTtlHours)),
      idlePruneDays: Math.max(1, nonNegativeInt(row.idlePruneDays, defaults.idlePruneDays)),
      aiEnabled: row.aiEnabled ?? defaults.aiEnabled,
      aiRelevanceMin: clamp(row.aiRelevanceMin, 0, 1, defaults.aiRelevanceMin),
      boostUntil: row.boostUntil ? new Date(row.boostUntil).toISOString() : null,
      legacyEnabled: row.legacyEnabled ?? defaults.legacyEnabled,
      // Fallback 0: отсутствующее/нулевое значение — legacy-строка, нужен adoption.
      qualityVersion: nonNegativeInt(row.qualityVersion, 0),
    };
  }
}
