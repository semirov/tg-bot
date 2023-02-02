import {Context, SessionFlavor} from 'grammy';
import {ConversationFlavor} from '@grammyjs/conversations';
import {UserEntity} from '../entities/user.entity';

export type BotConfig = { config: { user: UserEntity; isOwner: boolean } };

export interface SessionDataInterface {
  anonymousPublishing: boolean;
  lastChangedModeratorId?: number;
  lastPublishedAt?: number;
}

export type BotContext = Context &
  SessionFlavor<SessionDataInterface> &
  BotConfig &
  ConversationFlavor;
