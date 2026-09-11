import { Column, Entity, PrimaryColumn } from 'typeorm';

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

  @Column('timestamp', { default: 'NOW' })
  createdAt: Date;

  @Column('timestamp', { default: 'NOW', onUpdate: 'NOW' })
  updatedAt: Date;
}
