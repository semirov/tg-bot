import {Column, Entity, PrimaryColumn} from 'typeorm';

@Entity({name: 'channels'})
export class ChannelsEntity {
  @PrimaryColumn('bigint')
  id: number;

  @Column('varchar', {nullable: true})
  type: string;

  @Column('bigint')
  mainOwner: number;

  @Column('boolean', {default: true})
  isActive: boolean;

  @Column('timestamp', {default: 'NOW'})
  createdAt: Date;
}
