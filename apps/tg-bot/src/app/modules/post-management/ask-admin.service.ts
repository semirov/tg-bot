import {Inject, Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {ConversationsEnum} from './constants/conversations.enum';
import {BOT} from '../bot/providers/bot.provider';
import {Bot, InlineKeyboard} from 'grammy';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {BaseConfigService} from '../config/base-config.service';
import {UserService} from '../bot/services/user.service';
import {UserPostManagementService} from './user-post-management.service';
import {add} from 'date-fns';

@Injectable()
export class AskAdminService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userPostManagementService: UserPostManagementService
  ) {
  }

  onModuleInit() {
    this.bot.errorBoundary(
      (err) => Logger.log(err),
      createConversation(
        this.userAdminConversation.bind(this),
        ConversationsEnum.USER_ADMIN_CONVERSATION
      )
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

  public async userAdminConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply('Напиши то что хочешь и я передам админу\n\nЕсли передумал, нажми /cancel');

    const replyCtx = await conversation.wait();

    if (replyCtx?.message?.text === '/cancel') {
      await ctx.reply('Окей, если нужно меню - нажми /menu или просто пришли мем');
      return;
    }
    await ctx.reply('Я передам твое сообщение админу, он ответит тебе через бота');

    const menu = new InlineKeyboard()
      .text(
        'Ответить',
        `admin_user_dialog_start$${replyCtx.message.from.id}$${replyCtx.message.message_id}`
      )
      .row()
      .text(
        '💀 Бан',
        `admin_user_dialog_ban_user$${replyCtx.message.from.id}$${replyCtx.message.message_id}`
      )
      .row();

    await replyCtx.forwardMessage(this.baseConfigService.ownerId);
    await replyCtx.api.sendMessage(
      this.baseConfigService.ownerId,
      `Обращение пользователя @${replyCtx.message.from.username}`,
      {reply_markup: menu}
    );
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
      {reply_to_message_id: ctx.session.adminUserConversationMessageId}
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
        {id: +userId},
        {isBanned: true, bannedBy: ctx.callbackQuery.from.id}
      );

      await ctx.api.sendMessage(
        +userId,
        'К сожалению, мы вынуждены ограничить доступ к боту, т.к. ' +
        'ты серьезно нарушил правила нашего сообщества\n\n' +
        'Бот больше не будет реагировать на сообщения',
        {reply_to_message_id: +messageId}
      );
    });
  }
}
