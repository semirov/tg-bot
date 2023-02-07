import {Column, Entity, ManyToOne, PrimaryGeneratedColumn} from 'typeorm';
import {UserEntity} from "../../bot/entities/user.entity";

@Entity()
export class ObservatoryPostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text', {nullable: true})
  station: string;

  @Column('bigint', {nullable: true})
  requestChannelMessageId: string;

  @Column("bool", {nullable: true})
  isApproved: boolean;

  @ManyToOne(() => UserEntity, (user) => user.moderatedObservatoryPosts)
  processedByModerator: UserEntity;

}
