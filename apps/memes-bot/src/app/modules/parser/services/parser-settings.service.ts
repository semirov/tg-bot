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
  aiEnabled: boolean;
  aiRelevanceMin: number;
}

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
  }

  get current(): ParserRuntimeSettings {
    return this.cached;
  }

  /** Мастер-выключатель: env-флаг перекрывает настройки в БД. */
  get enabled(): boolean {
    return this.config.parserEnabled && this.cached.enabled;
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
      dailyLimit: 12,
      sourceDailyCap: 2,
      cringeShare: clamp(0.25, 0, 1, 0.25),
      minViews: 200,
      minReactions: 3,
      nvMin: 1.5,
      nrMin: 2,
      posShareMin: clamp(0.25, 0, 1, 0.25),
      hotScore: 4,
      cringeShareMin: clamp(0.12, 0, 1, 0.12),
      cringeMinViews: 100,
      errMin: 0.15,
      maxSources: 20,
      evalPreHours: 2,
      evalFinalHours: 12,
      candidateTtlHours: 48,
      aiEnabled: false,
      aiRelevanceMin: clamp(0.6, 0, 1, 0.6),
    };
  }

  private fromRow(row: ParserSettingsEntity): ParserRuntimeSettings {
    const defaults = this.buildDefaults();
    return {
      enabled: row.enabled ?? defaults.enabled,
      dailyLimit: nonNegativeInt(row.dailyLimit, defaults.dailyLimit),
      sourceDailyCap: Math.max(1, nonNegativeInt(row.sourceDailyCap, defaults.sourceDailyCap)),
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
      aiEnabled: row.aiEnabled ?? defaults.aiEnabled,
      aiRelevanceMin: clamp(row.aiRelevanceMin, 0, 1, defaults.aiRelevanceMin),
    };
  }
}
