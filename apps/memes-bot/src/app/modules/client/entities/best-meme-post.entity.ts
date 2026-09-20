import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Учёт постов, уже отправленных в канал «Лучшее»: постоянный дедуп, чтобы один
 * и тот же пост не попадал туда дважды (при низкой активности он иначе
 * выигрывает «лучший за сутки» несколько дней подряд).
 */
@Entity()
@Index('ux_best_meme_source', ['sourceMessageId'], { unique: true })
export class BestMemePostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** id поста в основном канале (MANAGED_CHANNEL). */
  @Column('int')
  sourceMessageId: number;

  /** id скопированного сообщения в канале «Лучшее». */
  @Column('bigint', { nullable: true })
  bestChannelMessageId: number | null;

  @CreateDateColumn()
  postedAt: Date;
}
