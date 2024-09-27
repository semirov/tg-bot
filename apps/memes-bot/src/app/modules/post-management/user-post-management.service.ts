import { Conversation, createConversation } from '@grammyjs/conversations';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { BOT } from '../bot/providers/bot.provider';
import { Bot, Composer, InlineKeyboard } from 'grammy';
import { ConversationsEnum } from './constants/conversations.enum';
import { Menu } from '@grammyjs/menu';
import { BaseConfigService } from '../config/base-config.service';
import { UserService } from '../bot/services/user.service';
import { UserPermissionEnum } from '../bot/constants/user-permission.enum';
import { PublicationModesEnum } from './constants/publication-modes.enum';
import { PostModerationMenusEnum } from './constants/post-moderation-menus.enum';
import { add, format, getUnixTime } from 'date-fns';
import { UserRequestService } from '../bot/services/user-request.service';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../bot/services/post-scheduler.service';
import { SettingsService } from '../bot/services/settings.service';
import { CringeManagementService } from '../bot/services/cringe-management.service';
import { DeduplicationService } from '../bot/services/deduplication.service';
import * as console from 'node:console';

export class UserPostManagementService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService,
    private postSchedulerService: PostSchedulerService,
    private settingsService: SettingsService,
    private cringeManagementService: CringeManagementService,
    private deduplicationService: DeduplicationService
  ) {}

  /**
   * Меню публикации одобренного поста
   */
  private moderatedPostMenu: Menu<BotContext>;
  private replyToBotContext: Composer<BotContext>;

  public readonly MEME_RULES =
    '<b>Для публикации принимаются:</b>\n' +
    '- Смищное\n' +
    '- Видео\n\n' +
    '<b>Мы можем изменить предложеный пост:</b>\n' +
    '- Подпись к картинкам или видео будет удалена\n' +
    '- Публикация может быть отклонена, если админу пост покажется не подходящим\n' +
    '- Публикуемые посты будут подписаны автором\n' +
    '- Пост может быть опубликован не сразу\n';

  public readonly cancelMessage =
    'Жаль что ты передумал, возвращайся снова!\nЧтобы показать основное меню бота, нажми /menu';

  public onModuleInit(): void {
    this.buildModeratedPostMenu();
    this.prepareReplyToBotContext();
    this.handleAdminUserResponse();
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
      .text('Показать правила', (ctx) => ctx.reply(this.MEME_RULES, { parse_mode: 'HTML' }))
      .text('Я передумал', async (ctx) => {
        await ctx.deleteMessage();
        await ctx.reply(this.cancelMessage);
        throw new Error('User exit from send meme conversation');
      })
      .row();

    await conversation.run(menu);

    const text =
      'Просто пришли пост, который ты хочешь опубликовать, возможно, то его опубликуют';

    await ctx.reply(text, { reply_markup: menu });
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
    try {
      await ctx.react('👍');
    } catch (e) {
      await ctx.reply('Мы все получили и скоро ответим');
      Logger.warn(
        `Cannot set message reaction for user message in bot ${ctx.me.id}`,
        UserPostManagementService.name
      );
    }

    const hash = await this.deduplicationService.getPostImageHash(ctx?.message?.photo);
    const duplicates = await this.deduplicationService.checkDuplicate(hash);
    if (duplicates.some((duplicate) => duplicate.distance >= 0.5)) {
      const [duplicate] = duplicates;
      await ctx.reply(
        'Такая публикация уже была'
      );
      await this.bot.api.forwardMessage(
        ctx.from.id,
        this.baseConfigService.memeChanelId,
        duplicate.memePostId
      );
      ctx.session.lastPublishedAt = null;
      return;
    }

    const user = await this.userService.repository.findOne({
      where: { id: ctx.message.from.id },
    });
    const { first_name, last_name, username, is_bot, is_premium } = ctx.message.from;
    const text = [
      'Пост от',
      is_premium ? '👑' : null,
      is_bot ? '🤖' : null,
      first_name,
      last_name,
      username ? `@${username}` : null,
      '\n#предложка',
    ]
      .filter((v) => !!v)
      .join(' ');
    await this.bot.api.sendMessage(this.baseConfigService.userRequestMemeChannel, text, {
      disable_notification: true,
    });
    const message = await ctx.api.copyMessage(
      this.baseConfigService.userRequestMemeChannel,
      ctx.message.chat.id,
      ctx.message.message_id,
      { reply_markup: this.moderatedPostMenu, disable_notification: true }
    );
    await this.bot.api.pinChatMessage(
      this.baseConfigService.userRequestMemeChannel,
      message.message_id,
      { disable_notification: true }
    );
    await this.userRequestService.repository.insert({
      user: user,
      isAnonymousPublishing: ctx.session.anonymousPublishing,
      originalMessageId: ctx.message.message_id,
      userRequestChannelMessageId: message.message_id,
    });
    await this.userService.updateUserLastActivity(ctx);
  }

  private buildModeratedPostMenu() {
    const menu = new Menu<BotContext>(PostModerationMenusEnum.MODERATION, { autoAnswer: false })
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
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
            relations: { processedByModerator: true },
          });
          return `✅ Опубликовать (${message.processedByModerator.username})`;
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
      .text('Кринж', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NIGHT_CRINGE))
      .text('Сейчас', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT))
      .row()
      .text('Ночью', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_NIGHT))
      .text('Утром', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_MORNING))
      .text('Днем', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_MIDDAY))
      .text('Вечером', async (ctx) => this.onPublishActions(ctx, PublicationModesEnum.NEXT_EVENING))
      .row()
      .text('Назад', (ctx) => ctx.menu.nav(PostModerationMenusEnum.APPROVAL));

    const rejectSubmenu = new Menu<BotContext>(PostModerationMenusEnum.REJECT, {
      autoAnswer: false,
    })
      .text(
        async (ctx) => {
          const message = await this.userRequestService.repository.findOne({
            select: ['processedByModerator'],
            where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
            relations: { processedByModerator: true },
          });
          await ctx.unpinChatMessage(ctx.callbackQuery.message.message_id);
          return `👨 Отклонен ❌ (${message.processedByModerator.username})`;
        },
        async (ctx) => {
          if (
            this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_DELETE_REJECTED_POST)
          ) {
            await ctx.deleteMessage();
          }
        }
      )
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

    const banConfirmation = new Menu<BotContext>(PostModerationMenusEnum.BAN, { autoAnswer: false })
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
      { id: message.id },
      {
        isApproved: true,
        processedByModerator: { id: ctx.callbackQuery.from.id },
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
      relations: { user: true },
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        isApproved: false,
        processedByModerator: { id: ctx.callbackQuery.from.id },
        moderatedAt: new Date(),
      }
    );
    await this.bot.api
      .forwardMessage(message.user.id, message.user.id, message.originalMessageId)
      .catch();
    await this.bot.api.sendMessage(
      message.user.id,
      'Мы не можем такое опубликовать, твой пост отклонен'
    );
  }

  /**
   * Обработка нажатия кнопки опубликовать для одобренного модераторами поста
   */
  public async onPublishActions(ctx: BotContext, mode: PublicationModesEnum) {
    if (!this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
      return;
    }

    await ctx.unpinChatMessage(ctx.callbackQuery.message.message_id);
    const imageHash = await this.deduplicationService.getPostImageHash(
      ctx?.callbackQuery?.message?.photo
    );

    const publishContext: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: ctx.callbackQuery.message.message_id,
      processedByModerator: ctx.callbackQuery.from.id,
      caption: ctx.callbackQuery?.message?.caption,
      isUserPost: true,
      hash: imageHash,
    };



    switch (mode) {
      case PublicationModesEnum.NOW_SILENT:
        return this.onPublishNow(publishContext);
      case PublicationModesEnum.NEXT_MORNING:
      case PublicationModesEnum.NEXT_MIDDAY:
      case PublicationModesEnum.NEXT_EVENING:
      case PublicationModesEnum.NEXT_NIGHT:
        return this.publishScheduled(publishContext);
      case PublicationModesEnum.NIGHT_CRINGE:
        return this.publishNightCringeScheduled(publishContext);
    }
  }

  private handleAdminUserResponse(): void {
    this.replyToBotContext.on(['message', 'channel_post'], async (ctx) => {
      const adminMessageId = ctx?.channelPost?.message_id || ctx?.message?.message_id;
      const message = await this.userRequestService.repository.findOne({
        where: { userRequestChannelMessageId: ctx.channelPost.reply_to_message.message_id },
        relations: { user: true },
      });


      try {
        // убираем реакцию у пользователя
        await this.bot.api.setMessageReaction(
          message.user.id,
          message.originalMessageId,
          []
        );
      } catch (e) {
        Logger.warn(
          `Cannot remove reaction message for user message for bot ${ctx.me.id}`,
          UserPostManagementService.name
        );
      }

      // копируем ответ пользователю
      await this.bot.api.copyMessage(message.user.id, ctx.chat.id, adminMessageId, {
        reply_to_message_id: message.originalMessageId,
      });
    });
  }


  public async onPublishNow(publishContext: ScheduledPostContextInterface) {
    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: publishContext.requestChannelMessageId,
      },
    });

    let caption = '';
    if (publishContext.caption) {
      caption += `${publishContext.caption}\n\n`;
    }

    if (!message.isAnonymousPublishing) {
      const chatInfo = await this.bot.api.getChat(message.user.id);
      if (chatInfo['username']) {
        caption += `#предложка @${chatInfo['username']}\n`;
      } else {
        caption += `#предложка ${[chatInfo['first_name'], chatInfo['last_name']]
          .filter((item) => !!item)
          .join(' ')}\n`;
      }
    } else {
      caption += `#предложка\n`;
    }

    if (publishContext.mode === PublicationModesEnum.NIGHT_CRINGE) {
      const channelHtmlLink = await this.settingsService.cringeChannelHtmlLink();
      caption += channelHtmlLink;
    } else {
      const channelHtmlLink = await this.settingsService.channelHtmlLinkIfPrivate();
      caption += channelHtmlLink;
    }
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);

    const publishedMessage = await this.bot.api.copyMessage(
      this.baseConfigService.memeChanelId,
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      {
        caption: caption,
        parse_mode: 'HTML',
        disable_notification: publishContext.caption === PublicationModesEnum.NOW_SILENT,
      }
    );

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        isPublished: true,
        publishedAt: new Date(),
        publishedBy: publishContext.processedByModerator,
        publishedMessageId: publishedMessage.message_id,
      }
    );

    await this.bot.api.forwardMessage(message.user.id, channelInfo.id, publishedMessage.message_id);

    let userFeedbackMessage = 'Твой пост опубликован \n';
    if (publishContext.mode !== PublicationModesEnum.NIGHT_CRINGE) {
      userFeedbackMessage += 'Присылай еще!\n';
    } else {
      const cringeChannelLink = await this.settingsService.cringeChannelHtmlLink();
      userFeedbackMessage += `Утром пост будет перемещен в канал ${cringeChannelLink}`;
    }

    await this.bot.api.sendMessage(message.user.id, userFeedbackMessage, { parse_mode: 'HTML' });

    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });

    const url = await this.settingsService.channelLinkUrl();
    const inlineKeyboard = new InlineKeyboard().url(`👨 Опубликован (${user.username})`, url).row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );

    if (publishContext.mode == PublicationModesEnum.NIGHT_CRINGE) {
      await this.cringeManagementService.repository.update(
        { requestChannelMessageId: publishContext.requestChannelMessageId },
        { memeChannelMessageId: publishedMessage.message_id }
      );
    }

    await this.deduplicationService.createPublishedPostHash(
      publishContext.hash,
      publishedMessage.message_id
    );
  }

  private async publishNightCringeScheduled(
    publicContext: ScheduledPostContextInterface
  ): Promise<void> {
    await this.cringeManagementService.repository.insert({
      requestChannelMessageId: publicContext.requestChannelMessageId,
      isUserPost: publicContext.isUserPost,
    });
    await this.publishScheduled(publicContext);
  }

  private async publishScheduled(publishContext: ScheduledPostContextInterface): Promise<void> {
    const publishDate = await this.postSchedulerService.addPostToSchedule(publishContext);

    if (!publishDate) {
      return;
    }

    const dateFormatted = format(
      PostSchedulerService.formatToMsk(publishDate),
      'dd.LL.yy в ~HH:mm'
    );

    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });

    const inlineKeyboard = new InlineKeyboard()
      .text(`⏰ ${dateFormatted} (${user.username})`)
      .row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );

    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: publishContext.requestChannelMessageId,
      },
    });

    await this.bot.api.forwardMessage(message.user.id, message.user.id, message.originalMessageId);

    let userFeedbackMessage = `Твой пост будет опубликован ${dateFormatted} ⏱\n\n`;
    if (publishContext.mode === PublicationModesEnum.NIGHT_CRINGE) {
      const cringeChannelLink = await this.settingsService.cringeChannelHtmlLink();
      userFeedbackMessage += `Пост попал в особую рубрику, которая публикуется только ночью, а утром перемещается в отдельный канал: ${cringeChannelLink}\n`;
    }
    userFeedbackMessage += 'Присылай еще 😉️';

    await this.bot.api.sendMessage(message.user.id, userFeedbackMessage, { parse_mode: 'HTML' });

    return Promise.resolve();
  }

  private async onAdminApproveAfterReject(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      relations: { user: true },
      where: {
        userRequestChannelMessageId: ctx.update.callback_query.message.message_id,
      },
    });

    await this.userRequestService.repository.update(
      { id: message.id },
      {
        restoredBy: ctx.config.user.id,
        isApproved: true,
      }
    );

    await this.bot.api.forwardMessage(message.user.id, message.user.id, message.originalMessageId);
    await this.bot.api.sendMessage(
      message.user.id,
      'Мы передумали! 🤯\n\n' +
        'Такое иногда бывает, мы долго думали, смеяли пост со всех сторон, показывали его всем кому могли, ' +
        'в итоге он будет опубликован! 🎉\n' +
        'Прости что так поступили с тобой, в следующий раз мы будем внимательнее. 🥺\n' +
        'P.S. Тебе придет отдельное сообщение, когда пост будет опубликован 😉'
    );
  }

  public async banUser(ctx: BotContext) {
    const message = await this.userRequestService.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    await this.userService.repository.update(
      { id: message.user.id },
      {
        isBanned: true,
        bannedBy: ctx.callbackQuery.from.id,
        banUntilTo: add(new Date(), { months: 1 }),
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
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    await this.userService.repository.update(
      { id: message.user.id },
      {
        strikes: (message.user.strikes || 0) + 1,
      }
    );
  }

  private async getUserStrikesCount(ctx: BotContext): Promise<number> {
    const message = await this.userRequestService.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
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

  private prepareReplyToBotContext(): void {
    this.replyToBotContext = this.bot.filter(async (ctx: BotContext) => {
      if ( !ctx?.channelPost?.reply_to_message && !ctx?.message?.reply_to_message) {
        return false;
      }
      const message = await this.userRequestService.repository.findOne({
        where: { userRequestChannelMessageId: ctx?.channelPost?.reply_to_message?.message_id || ctx?.message?.reply_to_message?.message_id },
      });
      return !!message;

    });
  }
}
