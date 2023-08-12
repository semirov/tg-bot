import {Column, Entity, PrimaryColumn} from 'typeorm';

@Entity({name: 'messages'})
export class MessagesEntity {
  /**
   * Исходное сообщение которое задано как анонимный вопрос боту
   */
  @PrimaryColumn('bigint')
  anonymousOriginalMessageId: number;

  /**
   * Копия сообщения которая была отправлена пользователю который получил анонимный вопрос
   */
  @Column('bigint', {nullable: true})
  anonymousMessageCopyId: number;

  /**
   * id пользователя задавшего анонимное сообщение
   */
  @Column('bigint')
  anonymousMessageFromUserId: number;

  /**
   * id пользователя кому было адресовано анонимное сообщение
   */
  @Column('bigint')
  anonymousMessageForUerId: number;

  /**
   * id сообщения ответа
   */
  @Column('bigint', {nullable: true})
  answerMessageId: number;

  @Column('timestamp', {default: 'NOW'})

  @Column('text', {nullable: true})
  questionText: string;

  @Column('text', {nullable: true})
  answerText: string;

  @Column('timestamptz', {default: 'NOW'})
  createdAt?: Date;
}
