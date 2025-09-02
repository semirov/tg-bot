import { Column, Entity, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { UserRequestEntity } from './user-request.entity';
import { ObservatoryPostEntity } from '../../observatory/entities/observatory-post.entity';

@Entity()
export class UserEntity {
  @PrimaryColumn('bigint')
  id: number;

  @Column('varchar', { nullable: true })
  username: string;

  @Column('varchar', { nullable: true })
  firstName: string;

  @Column('varchar', { nullable: true })
  lastName: string;

  @Column('boolean', { default: false })
  isBot: boolean;

  @Column('timestamp', { default: 'NOW' })
  public lastActivity: Date;

  @Column('integer', { default: 0 })
  public strikes: number;

  @Column('boolean', { default: false })
  public isBanned: boolean;

  @Column('bigint', { nullable: true })
  public bannedBy: number;

  @Column('timestamp', { nullable: true })
  public banUntilTo: Date;

  @Column('boolean', { default: false })
  public isModerator: boolean;

  @Column('boolean', { default: false })
  public allowPublishToChannel: boolean;

  @Column('boolean', { default: false })
  public allowDeleteRejectedPost: boolean;

  @Column('boolean', { default: false })
  public allowRestoreDiscardedPost: boolean;

  @Column('boolean', { default: false })
  public allowSetStrike: boolean;

  @Column('boolean', { default: false })
  public allowMakeBan: boolean;

  @Column('timestamp', { default: 'NOW' })
  createdAt: Date;

  @Column('boolean', { default: true })
  canBeModeratePosts: boolean;

  @Column('timestamp', { nullable: true })
  memeLimitDisabledUntil: Date;

  @OneToMany(() => UserRequestEntity, (postRequest) => postRequest.user)
  postRequests: UserRequestEntity[];

  @OneToMany(() => UserRequestEntity, (postRequest) => postRequest.processedByModerator)
  moderatedUserRequests: UserRequestEntity[];

  @OneToMany(() => ObservatoryPostEntity, (postRequest) => postRequest.processedByModerator)
  moderatedObservatoryPosts: ObservatoryPostEntity[];
}
