import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('channel_memes')
export class ChannelMemeEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  channelId!: string;

  @Column({ type: 'varchar', length: 50 })
  channelType!: 'main' | 'best';

  @Column({ type: 'bigint' })
  messageId!: number;

  @Column({ type: 'varchar', length: 500 })
  s3Key!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  caption?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  fileId?: string;

  @Column({ type: 'int', nullable: true })
  fileSize?: number;

  @CreateDateColumn()
  createdAt!: Date;
}
