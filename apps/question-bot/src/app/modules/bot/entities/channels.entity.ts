import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'channels' })
export class ChannelsEntity {
  @PrimaryColumn('bigint')
  id: number;

  @Column('varchar', { nullable: true })
  type: string;

  @Column('bigint')
  mainOwner: number;

  @Column('boolean', { default: true })
  isActive: boolean;

  @Column('text', { default: 'Задай мне анонимный вопрос' })
  anonymousQuestionText: string;

  @Column('timestamp', { default: 'NOW' })
  createdAt: Date;
}
