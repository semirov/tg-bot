import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CandidateOrigin, CandidateVerdict } from '../constants/parser.constants';

/** Кандидат на источник, найденный discovery (кросс-ссылки, t.me, похожие). */
@Entity()
@Index('ux_source_candidate_key', ['key'], { unique: true })
@Index('ix_source_candidate_verdict', ['verdict'])
export class SourceCandidateEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** Уникальный ключ: `u:<username>` или `c:<internalId>`. */
  @Column('varchar')
  key: string;

  @Column('varchar', { nullable: true })
  username: string | null;

  @Column('bigint', { nullable: true })
  chatId: string | null;

  @Column('varchar', { nullable: true })
  title: string | null;

  @Column('varchar', { default: CandidateOrigin.CROSS_LINK })
  origin: CandidateOrigin;

  /** Сколько раз канал встретился в кросс-ссылках. */
  @Column('int', { default: 1 })
  mentions: number;

  /** Подписчики из channels.getFullChannel (после web-check). */
  @Column('int', { nullable: true })
  subscribers: number;

  /** ERR-оценка: медиана просмотров web-preview / подписчики. */
  @Column('real', { nullable: true })
  errEstimate: number;

  /** Оценка постов в сутки из web-preview. */
  @Column('real', { nullable: true })
  postsPerDay: number | null;

  /** {category, relevance, nsfw, reason} — результат AI-классификации. */
  @Column('jsonb', { nullable: true })
  aiVerdict: { category: string; relevance: number; nsfw: boolean; reason?: string } | null;

  @Column('varchar', { default: CandidateVerdict.PENDING })
  verdict: CandidateVerdict;

  /** Сколько web-check прогонов прошло (кап на повторные проверки). */
  @Column('int', { default: 0 })
  attempts: number;

  @Column('text', { nullable: true })
  reason: string | null;

  @Column('timestamp', { nullable: true })
  checkedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
