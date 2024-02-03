import {Context, SessionFlavor} from 'grammy';
import {ConversationFlavor} from '@grammyjs/conversations';
import {BotEntity} from '../entities/bot.entity';

export type BotConfig = {
  config: { isOwner?: boolean; banned?: boolean; captchaMode?: boolean };
};

export interface SessionDataInterface {
  captchaValues?: { first: number; second: number; operand: string; result: number };
  currentBot?: BotEntity;
}

export type BotContext = Context &
  SessionFlavor<SessionDataInterface> &
  BotConfig &
  ConversationFlavor;
