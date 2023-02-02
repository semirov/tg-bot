import {Conversation, createConversation} from '@grammyjs/conversations';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {Inject, OnModuleInit} from '@nestjs/common';
import {BOT} from '../bot/providers/bot.provider';
import {Bot} from 'grammy';
import {ConversationsEnum} from './constants/conversations.enum';

export class UserAdminDialogConversation implements OnModuleInit {
  constructor(@Inject(BOT) private bot: Bot<BotContext>) {
  }

  public async conversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    // await ctx.reply('Это пока не работ');
  }

  public onModuleInit(): void {
    this.bot.use(
      createConversation(
        this.conversation,
        ConversationsEnum.USER_ADMIN_DIALOG_CONVERSATION
      )
    );
  }
}
