import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SourceCategory, SourceStatus } from '../constants/parser.constants';

/** Базлайн канала (медианы/перцентили по последним постам). */
export interface StoredBaseline {
  vmed: number;
  rmed: number;
  p90: number;
  posShare: number;
  sampleSize: number;
  updatedAt?: string;
}

/** Источник парсера: канал, из которого собираем посты. */
@Entity()
@Index('ux_source_channel_chat', ['chatId'], { unique: true })
@Index('ix_source_channel_status', ['status'])
export class SourceChannelEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** «Ботовый» id канала (-100XXXXXXXXXX). */
  @Column('bigint')
  chatId: string;

  /** channelId из MTProto (для getEntity/getMessages). */
  @Column('bigint', { nullable: true })
  rawChatId: string;

  @Column('varchar', { nullable: true })
  username: string | null;

  @Column('varchar', { nullable: true })
  title: string | null;

  @Column('varchar', { default: SourceCategory.MEMES })
  category: SourceCategory;

  @Column('varchar', { default: SourceStatus.ACTIVE })
  status: SourceStatus;

  /** Участники канала (channels.getFullChannel), обновляется раз в сутки. */
  @Column('int', { nullable: true })
  subscribers: number;

  /** ERR = медиана просмотров / подписчики (0..1+). */
  @Column('real', { nullable: true })
  err: number;

  @Column('jsonb', { nullable: true })
  baseline: StoredBaseline | null;

  /** Отобранных постов за всё время (для прунинга). */
  @Column('int', { default: 0 })
  selectedTotal: number;

  /** Отклонённых постов за последнее окно (для прунинга). */
  @Column('int', { default: 0 })
  rejectedTotal: number;

  @Column('timestamp', { nullable: true })
  statsUpdatedAt: Date | null;

  @Column('timestamp', { nullable: true })
  lastSweepAt: Date | null;

  @Column('timestamp', { nullable: true })
  lastErrorAt: Date | null;

  @Column('text', { nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
