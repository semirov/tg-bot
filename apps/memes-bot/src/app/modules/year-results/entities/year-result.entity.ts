import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class YearResultEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('integer')
  year: number;

  @Column('bigint')
  userId: number;

  @Column('varchar', { nullable: true })
  username: string;

  @Column('varchar', { nullable: true })
  firstName: string;

  @Column('varchar', { nullable: true })
  lastName: string;

  @Column('integer', { default: 0 })
  totalProposed: number;

  @Column('integer', { default: 0 })
  totalPublished: number;

  @Column('integer', { default: 0 })
  totalRejected: number;

  @Column('integer', { default: 0 })
  totalCringe: number;

  @Column('timestamptz', { nullable: true })
  firstProposalDate: Date;

  @Column('integer', { default: 0 })
  activeDays: number;

  @Column('integer', { default: 0 })
  longestStreak: number;

  @Column('timestamptz', { nullable: true })
  mostProductiveDay: Date;

  @Column('integer', { nullable: true })
  @Column('float', { nullable: true })
  approvalRate: number;

  @Column('float', { nullable: true })
  averageTimeToPublication: number;

  @Column('varchar', { nullable: true })
  mostActiveTimeOfDay: string;

  @Column('integer', { nullable: true })
  duplicatesCount: number;

  @Column('float', { nullable: true })
  duplicatesPercentage: number;

  mostProductiveDayCount: number;

  @Column('boolean', { default: false })
  isPublished: boolean;

  @Column('timestamptz', { default: 'NOW' })
  createdAt: Date;

  @Column('timestamptz', { nullable: true })
  publishedAt: Date;
}
