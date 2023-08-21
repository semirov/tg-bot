import {Column, Entity, PrimaryGeneratedColumn} from 'typeorm';

@Entity({name: 'predictions'})
export class PredictionsEntity {

  @PrimaryGeneratedColumn()
  id: number;

  @Column('text', {nullable: true})
  prediction: string;

  @Column('timestamptz', {default: 'NOW'})
  createdAt?: Date;
}
