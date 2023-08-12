import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class UserMessageModeratedPostEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', { nullable: true })
  userId: number;

  @Column('bigint', { nullable: true })
  userMessageId: number;

  @Column('bigint', { default: 0 })
  requestChannelMessageId: number;

  @Column('boolean', { default: false })
  voted: boolean;
}
