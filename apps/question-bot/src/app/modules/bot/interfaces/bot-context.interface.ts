import {Context, SessionFlavor} from 'grammy';
import {ConversationFlavor} from '@grammyjs/conversations';
import {UserEntity} from '../entities/user.entity';

export type BotConfig = { config: { user: UserEntity; isOwner: boolean } };

export interface SessionDataInterface {
  sendMessageToId?: number;
}

export type BotContext = Context &
  SessionFlavor<SessionDataInterface> &
  BotConfig &
  ConversationFlavor;
