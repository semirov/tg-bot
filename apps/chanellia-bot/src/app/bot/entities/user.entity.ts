import {Column, DeleteDateColumn, Entity, OneToMany, PrimaryColumn} from 'typeorm';
import {UserEntityInterface} from '@chanellia/common';
import {BotEntity} from './bot.entity';

@Entity({name: 'users'})
export class UserEntity implements UserEntityInterface {
  @PrimaryColumn('bigint')
  id: number;

  @Column('boolean', {default: false})
  banned: boolean;

  @OneToMany(() => BotEntity, (client) => client.user, {nullable: true})
  bots: BotEntity[];


  @Column('timestamp', {default: 'NOW'})
  lastActivity: Date;
}
