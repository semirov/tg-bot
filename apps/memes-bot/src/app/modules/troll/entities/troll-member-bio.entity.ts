import { Column, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Один устойчивый факт внутреннего досье участника.
 *
 * Досье — приватная долгая память бота: пользователю не показывается и не
 * цитируется. Вес — сила памяти; без подтверждений падает по периоду
 * полураспада, ниже порога факт вымывается.
 */
export interface TrollMemberBioFact {
  /** Формулировка факта (дистиллированная, без PII). */
  text: string;
  /** Долговечность/важность 1..5 — задаёт период полураспада. */
  importance: number;
  /** Сколько раз факт подтверждался. */
  count: number;
  /** Когда факт впервые появился (epoch ms). */
  firstSeenAt: number;
  /** Когда факт подтверждали в последний раз (epoch ms). */
  lastSeenAt: number;
  /** Вес на момент последнего подтверждения (до распада). */
  baseWeight: number;
  /** Текущий вес памяти (0..MAX). */
  weight: number;
}

/**
 * Внутреннее досье участника чата (одна строка на пару чат+участник).
 *
 * Факты хранятся как JSONB: сервис сам ведёт их жизненный цикл (слияние,
 * полураспад, вымывание). Курсор `lastMessageId` — докуда история обработана.
 */
@Entity()
@Unique(['chatId', 'userId'])
export class TrollMemberBioEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  chatId: number;

  @Column('bigint')
  userId: number;

  /** Имя на момент последнего обновления (для админ-просмотра). */
  @Column('varchar', { nullable: true })
  userName: string | null;

  /** id последнего сообщения, учтённого в досье. */
  @Column('bigint', { nullable: true })
  lastMessageId: number | null;

  /** Устойчивые факты досье (JSONB). */
  @Column('jsonb', { nullable: true })
  facts: TrollMemberBioFact[] | null;

  /** Когда досье обновлялось в последний раз. */
  @Column('timestamp', { nullable: true })
  lastEvaluatedAt: Date | null;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
