import {Context, SessionFlavor} from 'grammy';
import {ConversationFlavor} from '@grammyjs/conversations';

export type BotConfig = {
  config: { isOwner: boolean; banned?: boolean };
};

export interface SessionDataInterface {
  test: boolean;
}

export type BotContext = Context &
  SessionFlavor<SessionDataInterface> &
  BotConfig &
  ConversationFlavor;
