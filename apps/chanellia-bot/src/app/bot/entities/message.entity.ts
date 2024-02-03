import {Column, Entity, PrimaryColumn} from 'typeorm';

@Entity({name: 'messages'})
export class MessageEntity {
  @PrimaryColumn('bigint')
  userMessageId: number;

  @Column('bigint')
  botMessageId: number;

  @Column('bigint')
  userChatId: number;
}
