import {Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn} from 'typeorm';

@Entity({name: 'bots_users'})
export class BotsUsersEntity {
  @PrimaryColumn('bigint')
  botId: number;

  @PrimaryColumn('bigint')
  userId: number;

  @Column('boolean', {default: false})
  banned?: boolean;

  @Column('timestamp', {default: 'NOW'})
  public lastActivity?: Date;

  @CreateDateColumn()
  createdAt?: Date;

  @UpdateDateColumn()
  updatedAt?: Date;
}
