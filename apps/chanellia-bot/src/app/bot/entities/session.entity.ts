import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ISession } from '@grammyjs/storage-typeorm';

@Entity({ name: 'sessions' })
export class SessionEntity implements ISession {
  @PrimaryGeneratedColumn()
  id: string;

  @Column('varchar')
  key: string;

  @Column('text')
  value: string;
}
