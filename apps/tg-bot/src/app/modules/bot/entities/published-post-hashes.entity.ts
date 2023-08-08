import {Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn} from 'typeorm';
import {UserEntity} from './user.entity';
import {PublicationModesEnum} from "../../post-management/constants/publication-modes.enum";

@Entity()
export class PublishedPostHashesEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', {nullable: true})
  memeChannelMessageId: number;

  @Index()
  @Column('varchar', {length: 64, nullable: true})
  hash?: string;

  @Column('timestamptz', {default: 'NOW'})
  createdAt?: Date;
}
