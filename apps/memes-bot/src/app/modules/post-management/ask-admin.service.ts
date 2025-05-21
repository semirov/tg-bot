import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Conversation, createConversation } from '@grammyjs/conversations';
import { ConversationsEnum } from './constants/conversations.enum';
import { BOT } from '../bot/providers/bot.provider';
import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../config/base-config.service';
import { UserService } from '../bot/services/user.service';

@Injectable()
export class AskAdminService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService
  ) {}

  onModuleInit() {
    this.bot.errorBoundary(
      (err) => Logger.log(err),
    );
    this.bot.errorBoundary(
      (err) => Logger.log(err),
      createConversation(
        this.adminUserConversation.bind(this),
        ConversationsEnum.ADMIN_USER_CONVERSATION
      )
    );

    this.onAdminUserQuery();
  }


  public async adminUserConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply('Напиши ответ пользователю');

    const replyCtx = await conversation.wait();

    await ctx.api.copyMessage(
      ctx.session.adminUserConversationUserId,
      replyCtx.message.chat.id,
      replyCtx.message.message_id,
      {
        reply_to_message_id: ctx.session.adminUserConversationMessageId,
        disable_notification: true,
      }
    );
    ctx.session.adminUserConversationMessageId = undefined;
    ctx.session.adminUserConversationUserId = undefined;
    await ctx.reply('Сообщение отправлено пользователю');
    await ctx.deleteMessage();
  }

  private onAdminUserQuery(): void {
    this.bot.callbackQuery(/admin_user_dialog_start/, async (ctx) => {
      const [cmd, userId, messageId] = ctx.callbackQuery.data.split('$');

      ctx.session.adminUserConversationUserId = +userId;
      ctx.session.adminUserConversationMessageId = +messageId;

      await ctx.conversation.enter(ConversationsEnum.ADMIN_USER_CONVERSATION);
    });

    this.bot.callbackQuery(/admin_user_dialog_ban_user/, async (ctx) => {
      const [cmd, userId, messageId] = ctx.callbackQuery.data.split('$');

      await this.userService.repository.update(
        { id: +userId },
        { isBanned: true, bannedBy: ctx.callbackQuery.from.id }
      );

      await ctx.api.sendMessage(
        +userId,
        'К сожалению, мы вынуждены ограничить доступ к боту, т.к. ' +
          'ты серьезно нарушил правила нашего сообщества\n\n' +
          'Бот больше не будет реагировать на сообщения',
        { reply_to_message_id: +messageId }
      );
    });
  }
}
