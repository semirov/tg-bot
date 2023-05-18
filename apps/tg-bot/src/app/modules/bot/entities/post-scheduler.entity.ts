import {Column, Entity, ManyToOne, PrimaryGeneratedColumn} from 'typeorm';
import {UserEntity} from './user.entity';
import {PublicationModesEnum} from "../../post-management/constants/publication-modes.enum";

@Entity()
export class PostSchedulerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', {nullable: true})
  requestChannelMessageId: number;

  @ManyToOne(() => UserEntity, (user) => user.id)
  processedByModerator: UserEntity;

  @Column('timestamptz', {nullable: true})
  publishDate: Date;

  @Column('text', {nullable: true})
  mode: PublicationModesEnum;

  @Column('text', {nullable: true})
  caption: string;

  @Column('boolean', {default: false})
  isUserPost?: boolean;

  @Column('boolean', {default: false})
  isPublished?: boolean;

  @Column('timestamptz', {default: 'NOW'})
  createdAt?: Date;
}
