import {Injectable, Scope} from '@nestjs/common';
import {ManagedBotContext} from "../interfaces/managed-bot-context.interface";
import {Bot} from "grammy";

@Injectable({scope: Scope.TRANSIENT})
export class MessageHandler {

  public initHandler(bot: Bot<ManagedBotContext>): void {
    bot.on('message', ctx => ctx.reply('ok'));
  }

}
