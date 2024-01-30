import {Column, Entity, Index, PrimaryGeneratedColumn} from 'typeorm';
import {ISession} from '@grammyjs/storage-typeorm';

@Entity({name: 'bots_sessions'})
export class BotsSessionEntity implements ISession {
  @PrimaryGeneratedColumn()
  id: string;

  @Index()
  @Column('varchar')
  key: string;

  @Column('text')
  value: string;
}
