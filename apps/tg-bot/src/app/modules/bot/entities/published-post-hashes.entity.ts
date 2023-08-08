import {Column, Entity, Index, PrimaryGeneratedColumn} from 'typeorm';

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
