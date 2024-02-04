import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {AnyMessageBotHandler} from './any-message.bot-handler';
import {MyBotsBotCommand} from './my-bots.bot-command';
import {NewBotBotCommand} from './new-bot.bot-command';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {run} from '@grammyjs/runner';
import {StartBotCommand} from "./start.bot-command";

@Injectable()
export class BotInitializationService implements OnModuleInit {
  constructor(
    private anyMessageBotHandler: AnyMessageBotHandler,
    private myBotsBotCommand: MyBotsBotCommand,
    private newBotBotCommand: NewBotBotCommand,
    private startBotCommand: StartBotCommand,
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>
  ) {
  }

  public onModuleInit() {
    this.myBotsBotCommand.init();
    this.newBotBotCommand.init();
    this.anyMessageBotHandler.init();
    this.startBotCommand.init();

    run(this.bot);
  }
}
