import { Context, SessionFlavor } from 'grammy';
import { ConversationFlavor } from '@grammyjs/conversations';
import { UserEntity } from '../entities/user.entity';

export type BotConfig = { config: { user: UserEntity; isOwner: boolean } };

export interface CaptchaValuesInterface {
  first: number;
  second: number;
  operand: string;
  result: number;
}

export interface SessionDataInterface {
  anonymousPublishing: boolean;
  canBeModeratePosts: boolean;
  lastChangedModeratorId?: number;
  lastPublishedAt?: number;
  adminUserConversationUserId?: number;
  adminUserConversationMessageId?: number;
  captchaSolved?: boolean;
  captchaValues?: CaptchaValuesInterface;
  approveJoinRequest?: number;
  userVoted?: boolean;
}

export type BotContext = Context &
  SessionFlavor<SessionDataInterface> &
  BotConfig &
  ConversationFlavor;
