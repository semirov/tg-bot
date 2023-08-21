import {Column, Entity, PrimaryColumn} from 'typeorm';

@Entity({name: 'user_prediction'})
export class UserPredictionEntity {

  @PrimaryColumn('bigint')
  userId: number;

  @Column('bigint', {nullable: true})
  predictionId: number;


  @Column('text', {nullable: true})
  actualPredictionDate: string;
}
