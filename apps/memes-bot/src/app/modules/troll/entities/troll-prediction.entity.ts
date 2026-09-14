import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Кэш предсказаний /future: одно предсказание на пользователя в чате
 * на 12 часов. Старые записи периодически удаляются.
 */
@Entity()
@Index(['chatId', 'userId'])
export class TrollPredictionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  chatId: number;

  @Column('bigint')
  userId: number;

  @Column('text')
  text: string;

  /** Сколько раз запрашивали это предсказание (для наказания за настырность). */
  @Column('int', { default: 1 })
  requests: number;

  @Column('timestamp', { default: 'NOW' })
  createdAt: Date;
}
