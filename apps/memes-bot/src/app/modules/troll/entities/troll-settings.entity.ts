import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Настройки тролль-бота. Таблица-синглтон: всегда одна строка с id = 1.
 * Значения меняются владельцем через админ-меню.
 */
@Entity()
export class TrollSettingsEntity {
  @PrimaryColumn('int')
  id: number;

  @Column('boolean', { default: true })
  enabled: boolean;

  @Column('boolean', { default: true })
  criminalEnabled: boolean;

  @Column('real', { default: 0.5 })
  criminalThreshold: number;

  @Column('real', { default: 0.8 })
  criminalHighThreshold: number;

  @Column('boolean', { default: true })
  sarcasmEnabled: boolean;

  @Column('real', { default: 0.05 })
  sarcasmChance: number;

  @Column('int', { default: 300 })
  sarcasmCooldownSec: number;

  @Column('boolean', { default: true })
  mirrorEnabled: boolean;

  @Column('real', { default: 0.05 })
  mirrorChance: number;

  @Column('int', { default: 300 })
  mirrorCooldownSec: number;

  @Column('boolean', { default: true })
  reactionEnabled: boolean;

  @Column('real', { default: 0.05 })
  reactionChance: number;

  @Column('int', { default: 60 })
  reactionCooldownSec: number;

  @Column('boolean', { default: true })
  memeAnnounceEnabled: boolean;

  @Column('real', { default: 0.1 })
  memeAnnounceChance: number;

  @Column('boolean', { default: true })
  jerkEnabled: boolean;

  @Column('boolean', { default: true })
  addressReactionEnabled: boolean;

  @Column('int', { default: 15 })
  jerkBatchWindowSec: number;

  @Column('int', { default: 180 })
  jerkCooldownSec: number;

  @Column('int', { default: 15 })
  dialogPauseMin: number;

  @Column('int', { default: 15 })
  analyzeCooldownSec: number;

  @Column('int', { default: 2000 })
  dailyRequestLimit: number;

  @Column('int', { default: 1000 })
  maxInputChars: number;

  /** Самопроверка ответа ревизором с переписыванием при низкой оценке. */
  @Column('boolean', { default: true })
  selfCheckEnabled: boolean;

  /** Придумывать и обновлять смешные теги участников чата. */
  @Column('boolean', { default: true })
  memberTagsEnabled: boolean;

  /** Вести внутренние биографии участников (долгая память) и подмешивать в диалог. */
  @Column('boolean', { default: true })
  memberBioEnabled: boolean;

  /**
   * Смотреть картинки из чата vision-моделью и класть описание в историю.
   * Видео не анализируется — только пометка типа.
   */
  @Column('boolean', { default: true })
  visionEnabled: boolean;

  /**
   * Главная модель текстовых ответов: true — deepseek-v4-pro, false — deepseek-flash.
   * Разбор картинок всегда идёт на vision-модели (flash) независимо от этого флага.
   */
  @Column('boolean', { default: true })
  useProModel: boolean;

  /** Порог оценки: ниже него ответ уходит на переписывание. */
  @Column('real', { default: 0.6 })
  selfCheckThreshold: number;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
