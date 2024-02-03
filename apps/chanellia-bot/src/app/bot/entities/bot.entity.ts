import {Column, DeleteDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn} from 'typeorm';
import {BotEntityInterface} from "@chanellia/common";
import {UserEntity} from "./user.entity";

@Entity({name: 'bots'})
export class BotEntity implements BotEntityInterface {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  botId: number;

  @ManyToOne(() => UserEntity, (user) => user.bots)
  user: Partial<UserEntity>;

  @Column('text', {nullable: true})
  botUsername: string;

  @Column('text')
  botToken: string;

  @Column('timestamp', {default: 'NOW'})
  createdAt: Date;

  @Column('timestamp', {nullable: true})
  lastPing: Date;

  @DeleteDateColumn()
  public deletedAt: Date;
}
