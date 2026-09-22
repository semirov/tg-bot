import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Состояние алертов о пустеющей очереди публикации: одна строка (id=1)
 * хранит последний отправленный уровень и время отправки, чтобы не спамить
 * владельцу после перезапуска бота.
 */
@Entity('queue_alert_state')
export class QueueAlertStateEntity {
  @PrimaryColumn('int')
  id: number;

  @Column('text')
  level: string;

  @Column('timestamptz')
  sentAt: Date;
}
