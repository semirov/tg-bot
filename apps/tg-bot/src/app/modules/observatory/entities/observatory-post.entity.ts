import {Column, Entity, ManyToOne, PrimaryGeneratedColumn} from 'typeorm';
import {UserEntity} from "../../bot/entities/user.entity";

@Entity()
export class ObservatoryPostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', {nullable: true})
  requestChannelMessageId: number;

  @Column("bool", {nullable: true})
  isApproved: boolean;

  @ManyToOne(() => UserEntity, (user) => user.moderatedObservatoryPosts)
  processedByModerator: UserEntity;

  @Column('bigint', {nullable: true})
  publishedMessageId: number;

}
