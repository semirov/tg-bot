import {
  Column,
  Entity,
  PrimaryColumn,
} from 'typeorm';

@Entity()
export class SettingsEntity {
  @PrimaryColumn('bigint')
  id: number;

  @Column('text', {nullable: true})
  joinLink: string;
}
