import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Дефект, на который указал владелец.
 *
 * Владелец форварднул боту ответ, который считает неудачным, бот нашёл этот
 * ответ в истории переписки и записал сюда всё нужное для разбора: сам ответ,
 * реплику, на которую он отвечал, её автора и контекст беседы на тот момент.
 * Расширенная диагностика от старшей модели уходит владельцу в личку и тоже
 * сохраняется.
 */
@Entity()
@Index(['sourceChatId', 'botMessageId'])
export class TrollDefectEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** Чат-источник: откуда пришёл ответ бота (null — определить не удалось). */
  @Column('bigint', { nullable: true })
  sourceChatId: number | null;

  @Column('varchar', { nullable: true })
  sourceChatTitle: string | null;

  /** id ответа бота в Telegram: форвард его не несёт, поэтому часто null. */
  @Column('int', { nullable: true })
  botMessageId: number | null;

  /** Текст ответа бота — то, что владелец прислал как дефект. */
  @Column('text')
  botAnswer: string;

  /** Реплика, на которую бот отвечал. */
  @Column('int', { nullable: true })
  replyToMessageId: number | null;

  @Column('bigint', { nullable: true })
  replyToUserId: number | null;

  @Column('varchar', { nullable: true })
  replyToUserName: string | null;

  @Column('text', { nullable: true })
  replyToText: string | null;

  /** Контекст беседы на момент ответа — в том виде, в каком его видела модель. */
  @Column('text', { nullable: true })
  context: string | null;

  /** Как нашли исходный ответ: 'exact' — символ в символ, 'normalized' — после нормализации. */
  @Column('varchar', { length: 16, nullable: true })
  matchKind: string | null;

  /** Кто прислал дефект и куда. */
  @Column('bigint')
  reportedBy: number;

  @Column('bigint')
  reportedInChatId: number;

  /** Диагностика от старшей модели: серьёзность и разбор. */
  @Column('varchar', { length: 16, nullable: true })
  severity: string | null;

  @Column('text', { nullable: true })
  diagnosis: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
