import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Реплика истории переписки для контекста диалога.
 *
 * TTL — 24 часа: беседу помним сутки целиком, старое вычищается по крону.
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

  /** id сообщения в Telegram: нужен, чтобы показывать связи ответов. */
  @Column('int', { nullable: true })
  messageId: number | null;

  /** id сообщения, на которое отвечали (reply_to_message), если это ответ. */
  @Column('int', { nullable: true })
  replyToMessageId: number | null;

  @Column('text')
  content: string;

  // Именно CreateDateColumn, а не `default: 'NOW'`: строка 'NOW' в DDL
  // превращается Postgres'ом в константу времени создания таблицы, из-за чего
  // у всех записей оказывалась одна и та же метка времени.
  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
