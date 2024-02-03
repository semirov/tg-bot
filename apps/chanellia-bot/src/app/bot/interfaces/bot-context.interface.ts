import {Context, SessionFlavor} from 'grammy';
import {ConversationFlavor} from '@grammyjs/conversations';
import {BotEntity} from "../entities/bot.entity";

export type BotConfig = {
  config: { isOwner?: boolean; banned?: boolean };
};

export interface SessionDataInterface {
  currentClient?: BotEntity;
}

export type BotContext = Context &
  SessionFlavor<SessionDataInterface> &
  BotConfig &
  ConversationFlavor;
