import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';

@Entity()
export class UserRequestEntity {
  @PrimaryGeneratedColumn()
  id: string;

  @ManyToOne(() => UserEntity, (user) => user.postRequests)
  user: UserEntity;

  @Column('boolean', { nullable: false })
  public isAnonymousPublishing: boolean;

  @Column('bigint')
  originalMessageId: number;

  @Column('bigint', { nullable: true })
  userRequestChannelMessageId: number;

  @Column({ default: false })
  possibleDuplicate: boolean;

  @Column({ default: false })
  isDuplicate: boolean;

  @Column('bigint', { nullable: true })
  checkedByModerator: number;

  @Column('boolean', { nullable: true })
  isApproved: boolean;

  @ManyToOne(() => UserEntity, (user) => user.moderatedUserRequests)
  processedByModerator: UserEntity;

  @Column('timestamptz', { nullable: true })
  moderatedAt: Date;

  @Column('text', { nullable: true })
  fileUniqueId: string;

  @Column('bigint', { nullable: true })
  restoredBy: number;

  @Column('boolean', { nullable: true })
  isPublished: boolean;

  @Column('timestamptz', { nullable: true })
  publishedAt: Date;

  @Column('bigint', { nullable: true })
  public publishedBy: number;

  @Column('bigint', { nullable: true })
  publishedMessageId: number;

  @Column('timestamptz', { default: 'NOW' })
  createdAt: Date;

  @Column({ default: false })
  isTextRequest: boolean;

  @Column({ nullable: true })
  replyToMessageId: number;

  @Column({ nullable: true })
  scheduledDuplicateId: number;
}
