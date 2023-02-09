import {Conversation, createConversation} from '@grammyjs/conversations';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {Inject, Logger, OnModuleInit} from '@nestjs/common';
import {BOT} from '../bot/providers/bot.provider';
import {Bot, InlineKeyboard} from 'grammy';
import {ConversationsEnum} from './constants/conversations.enum';
import {Menu} from '@grammyjs/menu';
import {BaseConfigService} from '../config/base-config.service';
import {UserService} from '../bot/services/user.service';
import {UserPermissionEnum} from '../bot/constants/user-permission.enum';
import {PublicationModesEnum} from './constants/publication-modes.enum';
import {PostModerationMenusEnum} from './constants/post-moderation-menus.enum';
import {add, getUnixTime} from 'date-fns';
import {UserRequestService} from '../bot/services/user-request.service';

export class UserPostManagementService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService
  ) {
  }

  /**
   * Меню публикации одобренного поста
   */
  private moderatedPostMenu: Menu<BotContext>;

  public readonly MEME_RULES =
    '<b>Для публикации принимаются:</b>\n' +
    '- Смешные картинки\n' +
    '- Смешные видео\n\n' +
    '<b>Мы можем изменить предложеный мем:</b>\n' +
    '- Подпись к картинкам или видео будет удалена\n' +
    '- Публикация может быть отклонена, если админу мем покажется не смешным\n' +
    '- Публикуемые мемы будут подписаны автором\n' +
    '- Мем может быть опубликован не сразу\n';

  public readonly cancelMessage =
    'Жаль что ты передумал, возвращайся снова!\nЧтобы показать основное меню бота, нажми /menu';

  public onModuleInit(): void {

    this.buildModeratedPostMenu();
    this.bot.errorBoundary(
      (err) => Logger.log(err),
      createConversation(this.conversation.bind(this), ConversationsEnum.SEND_MEME_CONVERSATION)
    );
  }

  public async conversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    const menu = new Menu<BotContext>('inner-meme-menu')
      .text(
        (ctx) =>
          ctx.session.anonymousPublishing ? '🙈️ Публикуюсь анонимно' : '👁️ Публикуюсь не анонимно',
        (ctx) => {
          ctx.session.anonymousPublishing = !ctx.session.anonymousPublishing;
          ctx.menu.update();
        }
      )
      .row()
      .text('Показать правила', (ctx) => ctx.reply(this.MEME_RULES, {parse_mode: 'HTML'}))
      .text('Я передумал', async (ctx) => {
        await ctx.deleteMessage();
        await ctx.reply(this.cancelMessage);
        throw new Error('User exit from send meme conversation');
      })
      .row();

    await conversation.run(menu);

    const text =
      'Просто пришли мем, который ты хочешь опубликовать, если будет смешно, то его опубликуют';

    await ctx.reply(text, {reply_markup: menu});
    while (!ctx.message?.photo) {
      ctx = await conversation.wait();

      if (ctx.message?.photo || ctx.message?.video) {
        await this.handleUserMemeRequest(ctx);
        return;
      }

      if (ctx.message?.text === '/cancel') {
        await ctx.reply(this.cancelMessage);
        return;
      }

      if (ctx.message) {
        await ctx.reply(
          'К публикации принимаются только картинки и видео\nесли ты передумал, то нажми /cancel'
        );
      }
    }
  }

  public async handleUserMemeRequest(ctx: BotContext): Promise<void> {
    const isLastRequestMoreThanMinuteAgo = await this.isLastRequestMoreThanMinuteAgo(ctx);

    if (!isLastRequestMoreThanMinuteAgo) {
      await ctx.reply('Предлагать мемы можно не чаще чем раз в минуту');
      return;
    }

    const message = await ctx.api.copyMessage(
      this.baseConfigService.userRequestMemeChannel,
      ctx.message.chat.id,
      ctx.message.message_id,
      {reply_markup: this.moderatedPostMenu}
    );

    const user = await this.userService.repository.findOne({
      where: {id: ctx.message.from.id},
    });
    await this.userRequestService.repository.insert({
      user: user,
      isAnonymousPublishing: ctx.session.anonymousPublishing,
      originalMessageId: ctx.message.message_id,
      userRequestChannelMessageId: message.message_id,
    });
    await ctx.reply('Мем отправлен на одобрение 😎');
    await this.userService.updateUserLastActivity(ctx);
  }

  private buildModeratedPostMenu() {
    const menu = new Menu<BotContext>(PostModerationMenusEnum.MODERATION, {autoAnswer: false})
      .text('👍 Одобрить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.onModeratorApprovalActions(ctx);
          ctx.menu.nav(PostModerationMenusEnum.APPROVAL);
        }
      })
      .text('👎 Отклонить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.onModeratorRejectActions(ctx);
          ctx.menu.nav(PostModerationMenusEnum.REJECT);
        }
      })
      .row();

    const approvedSubmenu = new Menu<BotContext>(PostModerationMenusEnum.APPROVAL, {
      autoAnswer: false,
    })
      .text(
        async (ctx) => {
          const message = await this.userRequestService.repository.findOne({
            select: ['processedByModerator'],
            where: {userRequestChannelMessageId: ctx.callbackQuery.message.message_id},
            relations: {processedByModerator: true},
          });
          return `✅ Одобрен (${message.processedByModerator.username})`;
        },
        async (ctx) => {
          if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
            ctx.menu.nav(PostModerationMenusEnum.PUBLICATION);
          }
        }
      )
      .row()
      .text(async (ctx) => {
        const statistic = await this.userRequestService.userPostDiscardStatistic(ctx);
        return `👎 ${statistic.total} (${statistic.week})`;
      })
      .text(async (ctx) => {
        const statistic = await this.userRequestService.userPostApprovedStatistic(ctx);
        return `👍 ${statistic.total} (${statistic.day})`;
      })
      .text(async (ctx) => {
        const lastPostInfo = await this.userRequestService.lastPublishedPostTimeAgo(ctx);
        return `🗓 ${lastPostInfo}`;
      })
      .row();

    const publishSubmenu = new Menu<BotContext>(PostModerationMenusEnum.PUBLICATION, {
      autoAnswer: false,
    })
      .text('Сейчас 🔕', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT))
      .text('Сейчас 🔔', async (ctx) =>
        this.onPublishActions(ctx, PublicationModesEnum.NOW_WITH_ALARM)
      )
      // .row() // TODO
      // .text('Утром', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_MORNING))
      // .text('Днем', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_MIDDAY))
      // .text('Вечером', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_EVENING))
      // .text('Ночью', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_NIGHT))
      .row()
      .text('Назад', (ctx) => ctx.menu.nav(PostModerationMenusEnum.APPROVAL));

    const rejectSubmenu = new Menu<BotContext>(PostModerationMenusEnum.REJECT, {
      autoAnswer: false,
    })
      .text(async (ctx) => {
        const message = await this.userRequestService.repository.findOne({
          select: ['processedByModerator'],
          where: {userRequestChannelMessageId: ctx.callbackQuery.message.message_id},
          relations: {processedByModerator: true},
        });
        return `👨 Отклонен ❌ (${message.processedByModerator.username})`;
      }, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_DELETE_REJECTED_POST)) {
          await ctx.deleteMessage();
        }
      })
      .row()
      .text('🔁', async (ctx) => {
        if (
          this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_RESTORE_DISCARDED_POST)
        ) {
          await this.onAdminApproveAfterReject(ctx);
          ctx.menu.nav(PostModerationMenusEnum.APPROVAL);
        }
      })
      .text(
        async (ctx) => {
          const stikesCount = await this.getUserStrikesCount(ctx);
          return `❗ ${stikesCount || 0}`;
        },
        async (ctx) => {
          if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_SET_STRIKE)) {
            ctx.menu.nav(PostModerationMenusEnum.STRIKE);
          }
        }
      )
      .text('💀', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)) {
          await this.onAdminApproveAfterReject(ctx);
          ctx.menu.nav(PostModerationMenusEnum.BAN);
        }
      })
      .row();

    const banConfirmation = new Menu<BotContext>(PostModerationMenusEnum.BAN, {autoAnswer: false})
      .text('Точно в бан?', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)) {
          await this.banUser(ctx);
          await ctx.deleteMessage();
        }
        return;
      })
      .text('Нет', async (ctx) => {
        ctx.menu.nav(PostModerationMenusEnum.REJECT);
      })
      .row();

    const strikeConfirmation = new Menu<BotContext>(PostModerationMenusEnum.STRIKE, {
      autoAnswer: false,
    })
      .text('Точно добавить страйк?', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_SET_STRIKE)) {
          await this.makeUserStrike(ctx);
          ctx.menu.nav(PostModerationMenusEnum.REJECT);
        }
      })
      .text('Нет', async (ctx) => {
        ctx.menu.nav(PostModerationMenusEnum.REJECT);
      })
      .row();

    menu.register(publishSubmenu);
    menu.register(banConfirmation);
    menu.register(strikeConfirmation);
    menu.register(approvedSubmenu);
    menu.register(rejectSubmenu);

    this.moderatedPostMenu = menu;
    this.bot.use(this.moderatedPostMenu);
  }

  /**
   * Обработка нажатия кнопки одобрить
   */
  private async onModeratorApprovalActions(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });
    await this.userRequestService.repository.update(
      {id: message.id},
      {
        isApproved: true,
        processedByModerator: {id: ctx.callbackQuery.from.id},
        moderatedAt: new Date(),
      }
    );
    return;
  }

  /**
   * Обработка нажатия кнопки отклонить в для модерируемого поста
   */
  private async onModeratorRejectActions(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      relations: {user: true},
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    await this.userRequestService.repository.update(
      {id: message.id},
      {
        isApproved: false,
        processedByModerator: {id: ctx.callbackQuery.from.id},
        moderatedAt: new Date(),
      }
    );
    await this.bot.api
      .forwardMessage(message.user.id, message.user.id, message.originalMessageId)
      .catch();
    await this.bot.api.sendMessage(
      message.user.id,
      'Жаль, но твой мем отклонили и он не будет опубликован 😔\n\n' +
      'Не расстраивайся, ты всегда можешь предложить другой мем 😉'
    );
  }

  /**
   * Обработка нажатия кнопки опубликовать для одобренного модераторами поста
   */
  private async onPublishActions(ctx: BotContext, mode: PublicationModesEnum) {
    if (!this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
      return;
    }

    switch (mode) {
      case PublicationModesEnum.NOW_SILENT:
      case PublicationModesEnum.NOW_WITH_ALARM:
        return this.onPublishNow(ctx, mode);
      case PublicationModesEnum.NEXT_MORNING:
        return; // TODO
      case PublicationModesEnum.NEXT_MIDDAY:
        return; // TODO
      case PublicationModesEnum.NEXT_EVENING:
        return; // TODO
      case PublicationModesEnum.NEXT_NIGHT:
        return; // TODO
    }
  }

  private async onPublishNow(ctx: BotContext, mode: PublicationModesEnum) {
    const message = await this.userRequestService.repository.findOne({
      relations: {user: true},
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    let caption = '';
    if (ctx.callbackQuery?.message?.caption) {
      caption += `${ctx.callbackQuery?.message?.caption}\n\n`;
    }

    if (!message.isAnonymousPublishing) {
      const chatInfo = await this.bot.api.getChat(message.user.id);
      if (chatInfo['username']) {
        caption += `Мем предложил(а)`;
        caption += ` @${chatInfo['username']}`;
      }
    } else {
      caption += `Мем опубликован`;
    }
    const channelInfo = await ctx.api.getChat(this.baseConfigService.memeChanelId);
    caption += ` через <a href="https://t.me/${ctx.me.username}">бота</a>`;
    const link = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];
    caption += ` для <a href="${link}">канала ${channelInfo['title']}</a>`;

    const publishedMessage = await ctx.api.copyMessage(
      this.baseConfigService.memeChanelId,
      this.baseConfigService.userRequestMemeChannel,
      ctx.callbackQuery.message.message_id,
      {
        caption: caption,
        parse_mode: 'HTML',
        disable_notification: mode === PublicationModesEnum.NOW_SILENT,
      }
    );

    await this.userRequestService.repository.update(
      {id: message.id},
      {
        isPublished: true,
        publishedAt: new Date(),
        publishedBy: ctx.callbackQuery.from.id,
        publishedMessageId: publishedMessage.message_id,
      }
    );

    await this.bot.api.forwardMessage(message.user.id, channelInfo.id, publishedMessage.message_id);

    let userFeedbackMessage = 'Твой мем опубликован 👍\n\n';
    userFeedbackMessage += 'Спасибо что делишься смешными мемами, присылай еще! ❤️\n\n';
    userFeedbackMessage += 'P.S. Не забудь поделиться мемом с друзьями 😉';

    await this.bot.api.sendMessage(message.user.id, userFeedbackMessage);

    const postLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}/${publishedMessage.message_id}`
      : channelInfo['invite_link'];

    const inlineKeyboard = new InlineKeyboard()
      .url(`👨 Опубликован (${ctx.callbackQuery.from.username})`, postLink)
      .row();
    await ctx.editMessageReplyMarkup({reply_markup: inlineKeyboard});
  }

  private async onAdminApproveAfterReject(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      relations: {user: true},
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    await this.userRequestService.repository.update(
      {id: message.id},
      {
        restoredBy: ctx.config.user.id,
        isApproved: true,
      }
    );

    await this.bot.api.forwardMessage(message.user.id, message.user.id, message.originalMessageId);
    await this.bot.api.sendMessage(
      message.user.id,
      'Мы передумали! 🤯\n\n' +
      'Такое иногда бывает, мы долго думали, смеяли мем со всех сторон, показывали его всем кому могли, ' +
      'в итоге он будет опубликован! 🎉\n' +
      'Прости что так поступили с тобой, в следующий раз мы будем внимательнее. 🥺\n' +
      'P.S. Тебе придет отдельне сообщение, когда мем будет опубликован 😉'
    );
  }

  public async banUser(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: {userRequestChannelMessageId: ctx.callbackQuery.message.message_id},
      relations: {user: true},
    });

    await this.userService.repository.update(
      {id: message.user.id},
      {
        isBanned: true,
        bannedBy: ctx.callbackQuery.from.id,
        banUntilTo: add(new Date(), {months: 1}),
      }
    );

    await this.bot.api.sendMessage(
      message.user.id,
      'К сожалению, мы вынуждены ограничить доступ к боту, т.к. ' +
      'ты серьезно нарушил правила публикации и нашего сообщества, ' +
      'нам жаль что пришлось применить столь серьезную меру, ' +
      'но у нас не осталось иного выхода.\n\n' +
      'Бот больше не будет реагировать на сообщения'
    );
  }

  private async makeUserStrike(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: {userRequestChannelMessageId: ctx.callbackQuery.message.message_id},
      relations: {user: true},
    });

    await this.userService.repository.update(
      {id: message.user.id},
      {
        strikes: (message.user.strikes || 0) + 1,
      }
    );
  }

  private async getUserStrikesCount(ctx: BotContext): Promise<number> {
    const message = await this.userRequestService.repository.findOne({
      where: {userRequestChannelMessageId: ctx.callbackQuery.message.message_id},
      relations: {user: true},
    });

    return message.user.strikes;
  }

  private async isLastRequestMoreThanMinuteAgo(ctx: BotContext): Promise<boolean> {
    if (
      !ctx.session?.lastPublishedAt ||
      ctx.session?.lastPublishedAt + 60 < getUnixTime(new Date())
    ) {
      ctx.session.lastPublishedAt = getUnixTime(new Date());
      return true;
    }
    return false;
  }
}
