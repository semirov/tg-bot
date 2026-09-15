import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Реплика истории переписки для контекста диалога.
 *
 * Хранится в БД ограниченное время (TTL, по умолчанию 24 часа) — старые
 * записи периодически удаляются, чтобы не разрасталось хранилище.
 * Текст сообщений в логи не пишется.
 */
@Entity()
@Index(['chatId', 'id'])
export class TrollMessageEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  chatId: number;

  /** Автор сообщения (только для реплик пользователей). */
  @Column('bigint', { nullable: true })
  userId: number;

  /** Отображаемое имя автора. */
  @Column('varchar', { nullable: true })
  userName: string;

  /** 'user' | 'assistant' */
  @Column('varchar', { length: 16 })
  role: string;

  @Column('text')
  content: string;

  // Именно CreateDateColumn, а не `default: 'NOW'`: строка 'NOW' в DDL
  // превращается Postgres'ом в константу времени создания таблицы, из-за чего
  // у всех записей оказывалась одна и та же метка времени.
  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
