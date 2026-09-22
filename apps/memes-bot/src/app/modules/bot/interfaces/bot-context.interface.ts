import { ConversationFlavor } from '@grammyjs/conversations';
import { Context, SessionFlavor } from 'grammy';
import { YearResultsPreview } from '../../year-results/interfaces/year-statistics.interface';
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
  lastChangedModeratorId?: number;
  lastPublishedAt?: number;
  adminUserConversationUserId?: number;
  adminUserConversationMessageId?: number;
  captchaSolved?: boolean;
  captchaValues?: CaptchaValuesInterface;
  approveJoinRequest?: number;
  memeLimitControlState?: string;
  memeLimitUserId?: number;
  yearResultsPreview?: YearResultsPreview;
  yearResultsCurrentUserIndex?: number;
}

type BotContextBase = Context & SessionFlavor<SessionDataInterface> & BotConfig;

export type BotContext = BotContextBase & ConversationFlavor<BotContextBase>;
