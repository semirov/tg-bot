import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryColumn('bigint')
  id: number;

  @Column('varchar', { nullable: true })
  username: string;

  @Column('varchar', { nullable: true })
  firstName: string;

  @Column('varchar', { nullable: true })
  lastName: string;

  @Column('boolean', { default: false })
  isBot: boolean;

  @Column('timestamp', { default: 'NOW' })
  public lastActivity: Date;

  @Column('boolean', { default: false })
  public isBanned: boolean;

  @Column('timestamp', { default: 'NOW' })
  createdAt: Date;
}
