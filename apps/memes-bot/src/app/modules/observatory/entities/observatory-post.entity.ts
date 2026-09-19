import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from '../../bot/entities/user.entity';

@Entity()
export class ObservatoryPostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', { nullable: true })
  requestChannelMessageId: number;

  @Column('bool', { nullable: true })
  isApproved: boolean;

  @ManyToOne(() => UserEntity, (user) => user.moderatedObservatoryPosts)
  processedByModerator: UserEntity;

  @Column('bigint', { nullable: true })
  publishedMessageId: number;

  /** Числовой id исходного канала, из которого пришёл пост. */
  @Column('bigint', { nullable: true })
  sourceChatId: number | null;

  /** Id исходного поста в исходном канале. */
  @Column('int', { nullable: true })
  sourceMessageId: number | null;

  /** Username исходного канала (без `@`). */
  @Column('varchar', { nullable: true })
  sourceUsername: string | null;

  /** Название исходного канала. */
  @Column('varchar', { nullable: true })
  sourceTitle: string | null;

  /** Ссылка на исходный пост/канал. */
  @Column('text', { nullable: true })
  sourceUrl: string | null;

  /** Исходная подпись поста (служебная подпись в предложке её не заменяет). */
  @Column('text', { nullable: true })
  originalCaption: string | null;
}
