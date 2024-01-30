import {Column, Entity, Index, PrimaryGeneratedColumn} from 'typeorm';
import {ClientEntityInterface} from "common";

@Entity({name: 'clients'})
export class ClientEntity implements ClientEntityInterface {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column('bigint')
  adminUserId: number;

  @Column('bigint')
  botId: number;

  @Column('text')
  botToken: string;

  @Column('boolean', {default: true})
  active: boolean;

  @Column('timestamp', {default: 'NOW'})
  createdAt: Date;

  @Column('timestamp', {nullable: true})
  lastPing: Date;
}
