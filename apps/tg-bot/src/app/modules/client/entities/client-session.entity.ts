import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity()
export class ClientSessionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text', {nullable: true})
  station: string;

  @Column('text', {nullable: true})
  session: string;

  @Column('boolean', {default: false})
  isActive: boolean;
}
