import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class CringePostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', { nullable: true })
  requestChannelMessageId: number;

  @Column('bigint', { nullable: true })
  memeChannelMessageId: number;

  @Column('bigint', { nullable: true })
  cringeChannelMessageId: number;

  @Column('boolean', { default: false })
  isUserPost?: boolean;

  @Column('boolean', { default: false })
  isMovedToCringe?: boolean;

  @Column('timestamptz', { default: 'NOW' })
  createdAt?: Date;
}
