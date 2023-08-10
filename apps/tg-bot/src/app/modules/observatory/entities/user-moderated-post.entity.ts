import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';
import {PublicationModesEnum} from "../../post-management/constants/publication-modes.enum";

@Entity()
export class UserModeratedPostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', {nullable: true})
  requestChannelMessageId: number;

  @Column("bigint", {default: 0})
  likes: number;

  @Column("bigint", {default: 0})
  dislikes: number;

  @Column('text', {nullable: true})
  mode: PublicationModesEnum;

  @Column('boolean', {default: false})
  isApproved?: boolean;

  @Column('boolean', {default: false})
  isRejected?: boolean;

  @Column('timestamptz', {nullable: true, default: null})
  moderatedTo?: Date;

  @Column('bigint', {nullable: false})
  moderatedUsersCount: number;

  @Column('bigint', {nullable: true})
  processedByModerator: number;

  @Column('text', {nullable: true})
  caption?: string;

  @Column('varchar', {length: 64, nullable: true})
  hash?: string;
}
