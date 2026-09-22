import { Column, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Текущий «наречённый» тег участника чата (Bot API `setChatMemberTag`).
 *
 * Одна строка на пару (чат, участник): хранит применённый тег, причину и
 * ключевые темы, чтобы не дёргать Telegram зря и держать антифлуд.
 */
@Entity()
@Unique(['chatId', 'userId'])
export class TrollMemberTagEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  chatId: number;

  @Column('bigint')
  userId: number;

  /** Имя на момент наречения — для объявления. */
  @Column('varchar', { nullable: true })
  userName: string | null;

  /** Применённый тег (≤16 символов, без эмодзи). */
  @Column('varchar', { length: 16, nullable: true })
  tag: string | null;

  /** Причина наречения из промпта (матерная, в тему). */
  @Column('text', { nullable: true })
  reason: string | null;

  /** Ключевые темы участника, через запятую. */
  @Column('text', { nullable: true })
  topics: string | null;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
