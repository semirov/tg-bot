import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Чат (группа/супергруппа), в который был добавлен бот.
 *
 * Бот начинает работать в чате только после того, как владелец
 * подтвердит активацию (isActive = true).
 */
@Entity()
export class TrollChatEntity {
  @PrimaryColumn('bigint')
  chatId: number;

  @Column('varchar', { nullable: true })
  title: string;

  @Column('boolean', { default: false })
  isActive: boolean;

  @Column('bigint', { nullable: true })
  addedByUserId: number;

  /** Время последнего /sumarize в чате — для общего кулдауна (1 час). */
  @Column('timestamp', { nullable: true })
  lastSummaryAt: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
