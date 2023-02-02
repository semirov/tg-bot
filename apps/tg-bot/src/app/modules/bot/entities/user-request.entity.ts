import {Column, Entity, ManyToOne, PrimaryGeneratedColumn} from 'typeorm';
import {UserEntity} from './user.entity';

@Entity()
export class UserRequestEntity {
  @PrimaryGeneratedColumn()
  id: string;

  @ManyToOne(() => UserEntity, (user) => user.postRequests)
  user: UserEntity;

  @Column('boolean', {nullable: true})
  public isAnonymousPublishing: boolean;

  @Column('bigint')
  originalMessageId: number;

  @Column('bigint', {nullable: true})
  userRequestChannelMessageId: number;

  @Column('boolean', {nullable: true})
  isApproved: boolean;

  @Column('bigint', {nullable: true})
  processedByModerator: number;

  @Column('timestamptz', {nullable: true})
  moderatedAt: Date;

  @Column('bigint', {nullable: true})
  restoredBy: number;

  @Column('boolean', {nullable: true})
  isPublished: boolean;

  @Column('timestamptz', {nullable: true})
  publishedAt: Date;

  @Column('bigint', {nullable: true})
  public publishedBy: number;

  @Column('bigint', {nullable: true})
  publishedMessageId: number;

  @Column('timestamptz', {default: 'NOW'})
  createdAt: Date;
}
