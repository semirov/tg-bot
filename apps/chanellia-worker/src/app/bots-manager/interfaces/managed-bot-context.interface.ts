import {Context, SessionFlavor} from 'grammy';
import {ConversationFlavor} from '@grammyjs/conversations';

export type ManagedBotConfig = { config: { isOwner: boolean, banned?: boolean } };

export interface ManagedSessionDataInterface {
  test: boolean;
}

export type ManagedBotContext = Context &
  SessionFlavor<ManagedSessionDataInterface> &
  ManagedBotConfig &
  ConversationFlavor;
