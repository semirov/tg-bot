import { Column, Entity, UpdateDateColumn } from 'typeorm';

/**
 * Настройки парсера (singleton, id=1, как у тролля). Значения колонок —
 * дефолты, рантайм читает кэш через ParserSettingsService.
 */
@Entity()
export class ParserSettingsEntity {
  @Column('int', { primary: true })
  id: number;

  /** Мастер-выключатель конвейера (кроны и live-сбор). */
  @Column('bool', { default: true })
  enabled: boolean;

  /** Посты из парсера в предложку за сутки (0 = безлимит). */
  @Column('int', { default: 0 })
  dailyLimit: number;

  /** Максимум постов с одного источника за сутки (0 = безлимит). */
  @Column('int', { default: 0 })
  sourceDailyCap: number;

  /** Доля кринжа от дневного лимита (0..1). */
  @Column('real', { default: 0.25 })
  cringeShare: number;

  /** Абсолютный пол по просмотрам. */
  @Column('int', { default: 100 })
  minViews: number;

  /** Абсолютный пол по реакциям. */
  @Column('int', { default: 1 })
  minReactions: number;

  /** Пост должен быть лучше медианы канала в nvMin раз (или nrMin/nr). */
  @Column('real', { default: 0.8 })
  nvMin: number;

  @Column('real', { default: 1 })
  nrMin: number;

  /** Минимальная доля положительных реакций. */
  @Column('real', { default: 0 })
  posShareMin: number;

  /** Скор раннего выхода (t+2ч): nv+nr >= hotScore. */
  @Column('real', { default: 2 })
  hotScore: number;

  /** Минимальная доля 🤡/💩 для кринж-категории. */
  @Column('real', { default: 0.05 })
  cringeShareMin: number;

  /** Абсолютный пол просмотров для кринжа. */
  @Column('int', { default: 50 })
  cringeMinViews: number;

  /** Минимальный ERR канала (медиана просмотров / подписчики). */
  @Column('real', { default: 0.25 })
  errMin: number;

  /** Максимум активных источников (бюджет каналов). */
  @Column('int', { default: 40 })
  maxSources: number;

  /** Сколько дней без взятых постов терпим источник, затем отключаем. */
  @Column('int', { default: 3 })
  idlePruneDays: number;

  /** Ранний отбор, часов после сбора. */
  @Column('int', { default: 2 })
  evalPreHours: number;

  /** Финальный отбор, часов после сбора. */
  @Column('int', { default: 12 })
  evalFinalHours: number;

  /** TTL кандидата, часов (истёк — expired). */
  @Column('int', { default: 96 })
  candidateTtlHours: number;

  /** AI-классификация (DeepSeek, текст): канал-кандидаты и посты. */
  @Column('bool', { default: false })
  aiEnabled: boolean;

  /** Минимальная релевантность канала-кандидата от AI. */
  @Column('real', { default: 0.6 })
  aiRelevanceMin: number;

  /** До какого времени действует режим «Насыпать ещё» (boost). */
  @Column('timestamp', { nullable: true })
  boostUntil: Date | null;

  /** Старый парсер (обсерватория): приём постов от юзербота в предложку. */
  @Column('bool', { default: true })
  legacyEnabled: boolean;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
