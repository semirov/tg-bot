import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EvalStage, ObservedStatus } from '../constants/parser.constants';
import { PostMetrics } from '../domain/parser-scoring';

/** Кандидат: медиапост, собранный из источника. */
@Entity()
@Index('ux_observed_source_msg', ['sourceChatId', 'sourceMessageId'], { unique: true })
@Index('ix_observed_status', ['status'])
@Index('ix_observed_score', ['status', 'score'])
@Index('ix_observed_media_unique', ['mediaUniqueId'])
export class ObservedPostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  sourceChatId: string;

  @Column('int')
  sourceMessageId: number;

  /** Порядковый номер поста в MTProto канале (стабильный ключ перечитывания). */
  @Column('bigint', { nullable: true })
  rawChatId: string;

  /** Сообщения альбома (если пост из группы медиа). */
  @Column('jsonb', { nullable: true })
  groupIds: number[] | null;

  /** Идентификатор медиа: Api.Photo.id / Document.id (строкой). */
  @Column('varchar', { nullable: true })
  mediaUniqueId: string | null;

  /** 'photo' | 'video'. */
  @Column('varchar', { default: 'photo' })
  mediaKind: string;

  /** Форс: пост разошёлся по 3+ каналам — в предложку без скоринга. */
  @Column('boolean', { default: false })
  forced: boolean;

  @Column('text', { nullable: true })
  caption: string | null;

  /** Кросс-ссылки: forward-источник поста. */
  @Column('bigint', { nullable: true })
  fwdFromChatId: string | null;

  /** t.me-ссылки из текста (jsonb, массив username'ов/chatId). */
  @Column('jsonb', { nullable: true })
  crossLinks: Array<{ username?: string; chatId?: number }> | null;

  @Column('bigint', { nullable: true })
  views: number;

  @Column('int', { nullable: true })
  reactions: number;

  @Column('jsonb', { nullable: true })
  metrics: PostMetrics | null;

  @Column('real', { nullable: true })
  score: number;

  @Column('varchar', { default: ObservedStatus.PENDING })
  status: ObservedStatus;

  @Column('varchar', { default: EvalStage.PRE })
  evalStage: EvalStage;

  @Column('text', { nullable: true })
  rejectReason: string | null;

  @Column('timestamp', { nullable: true })
  evaluatedAt: Date | null;

  @Column('timestamp', { nullable: true })
  deliveredAt: Date | null;

  /** message_id карточки в предложке (USER_REQUEST_CHANNEL). */
  @Column('bigint', { nullable: true })
  requestChannelMessageId: number;

  /** message_id опубликованного поста в основном канале. */
  @Column('bigint', { nullable: true })
  publishedMessageId: number;

  /** imghash 16 бит, считается при доставке (дедуп против опубликованных). */
  @Column('varchar', { nullable: true })
  imageHash: string | null;

  /** imghash 64 бит для склейки одинаковых мемов из разных каналов в предложке. */
  @Column('varchar', { nullable: true })
  perceptualHash: string | null;

  /** Карточка, в которую склеен этот дубликат (id основного кандидата). */
  @Column('int', { nullable: true })
  duplicateOfId: number | null;

  /** Доп. источники, у которых найден тот же мем (склейка карточки). */
  @Column('jsonb', { nullable: true })
  extraSources: Array<{ chatId: string; title: string | null; username: string | null }> | null;

  /** Первый (самый ранний) источник мема — показывается в подписи первым. */
  @Column('bigint', { nullable: true })
  rootSourceChatId: string | null;

  @Column('varchar', { nullable: true })
  rootSourceTitle: string | null;

  @Column('varchar', { nullable: true })
  rootSourceUsername: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
