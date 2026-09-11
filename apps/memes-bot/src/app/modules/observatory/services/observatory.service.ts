import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Menu } from '@grammyjs/menu';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { UserPermissionEnum } from '../../bot/constants/user-permission.enum';
import { UserService } from '../../bot/services/user.service';
import { Bot, InlineKeyboard } from 'grammy';
import { BOT } from '../../bot/providers/bot.provider';
import { BaseConfigService } from '../../config/base-config.service';
import { UserRequestService } from '../../bot/services/user-request.service';
import { ClientBaseService } from '../../client/services/client-base.service';
import { ObservatoryPostMenusEnum } from '../contsants/observatory-post-menus.enum';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObservatoryPostEntity } from '../entities/observatory-post.entity';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../../bot/services/post-scheduler.service';
import { format } from 'date-fns';
import { SettingsService } from '../../bot/services/settings.service';
import { CringeManagementService } from '../../bot/services/cringe-management.service';
import { DeduplicationService } from '../../bot/services/deduplication.service';
import { UserModeratedPostService } from './user-moderated-post.service';
import { MattermostService } from '../../mattermost/mattermost.service';

@Injectable()
export class ObservatoryService implements OnModuleInit {
  private readonly logger = new Logger(ObservatoryService.name);

  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private clientBaseService: ClientBaseService,
    @InjectRepository(ObservatoryPostEntity)
    private observatoryPostRepository: Repository<ObservatoryPostEntity>,
    private postSchedulerService: PostSchedulerService,
    private settingsService: SettingsService,
    private cringeManagementService: CringeManagementService,
    private deduplicationService: DeduplicationService,
    private userModeratedPostService: UserModeratedPostService,
    private mattermostService: MattermostService
  ) {}

  /**
   * Меню публикации одобренного поста
   */
  private observatoryPostMenu: Menu<BotContext>;

  public onModuleInit(): void {
    this.bot.use(this.userModeratedPostService.buildUserModeratePost());
    this.onNewObservatoryPost();
    this.onNewUserModeratedPost();
    this.waitDeleteObserverPost();
    this.buildObservatoryPostMenu();
  }

  private onNewUserModeratedPost() {
    this.userModeratedPostService.userModeratedPost$.subscribe(async (ctx) => {
      await this.publishWithContext(ctx.mode, ctx);
    });
  }

  private onNewObservatoryPost() {
    this.clientBaseService.observerChannelPost$.subscribe(async (ctx) => {
      const imageHash = await this.deduplicationService.getPostImageHash(ctx?.channelPost?.photo);
      const duplicates = await this.deduplicationService.checkDuplicate(imageHash);
      // если есть дубликат с похожестью больше 0.5 - выкидываем пост
      if (duplicates.some((duplicate) => duplicate.distance >= 0.5)) {
        return;
      }
      const message = await ctx.api.copyMessage(
        this.baseConfigService.userRequestMemeChannel,
        ctx.channelPost.sender_chat.id,
        ctx.channelPost.message_id,
        { disable_notification: true, caption: '', reply_markup: this.observatoryPostMenu }
      );

      const post = await this.observatoryPostRepository.create({
        requestChannelMessageId: message.message_id,
      });
      await this.observatoryPostRepository.save(post);
    });
  }

  private buildObservatoryPostMenu(): void {
    this.observatoryPostMenu = new Menu<BotContext>(ObservatoryPostMenusEnum.POST_MENU, {
      autoAnswer: false,
    })
      .text('🤖 Пост обсерватории')
      .row()
      .text('Опубликовать', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          ctx.menu.nav(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION);
        }
      })
      .text('Отклонить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.rejectObserverPost(ctx);
        }
      })
      .row()
      .text('На модерацию пользователям', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          ctx.menu.nav(ObservatoryPostMenusEnum.USER_MODERATE_POST);
        }
      })
      .row();

    const publishSubmenu = new Menu<BotContext>(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, {
      autoAnswer: false,
    })
      .text('Кринж', async (ctx) => this.publishPost(ctx, PublicationModesEnum.NIGHT_CRINGE))
      .text('Сейчас', async (ctx) => this.publishPost(ctx, PublicationModesEnum.NOW_SILENT))
      .row()
      .text('Ближайший слот', async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_INTERVAL)
      )
      .row()
      .text('Ночью', async (ctx) => this.publishPost(ctx, PublicationModesEnum.NEXT_NIGHT))
      .text('Утром', async (ctx) => this.publishPost(ctx, PublicationModesEnum.NEXT_MORNING))
      .text('Днем', async (ctx) => this.publishPost(ctx, PublicationModesEnum.NEXT_MIDDAY))
      .text('Вечером', async (ctx) => this.publishPost(ctx, PublicationModesEnum.NEXT_EVENING))
      .row()
      .text('Назад', (ctx) => ctx.menu.nav(ObservatoryPostMenusEnum.POST_MENU));

    const userModeratePost = new Menu<BotContext>(ObservatoryPostMenusEnum.USER_MODERATE_POST, {
      autoAnswer: false,
    })
      .text('Сейчас', async (ctx) => this.moderateViaUsers(ctx, PublicationModesEnum.NOW_SILENT))
      .row()
      .text('Ближайший слот', async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_INTERVAL)
      )
      .row()
      .text('Ночью', async (ctx) => this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_NIGHT))
      .text('Утром', async (ctx) => this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_MORNING))
      .text('Днем', async (ctx) => this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_MIDDAY))
      .text('Вечером', async (ctx) => this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_EVENING))
      .row()
      .text('Назад', (ctx) => ctx.menu.nav(ObservatoryPostMenusEnum.POST_MENU));

    this.observatoryPostMenu.register(publishSubmenu);
    this.observatoryPostMenu.register(userModeratePost);

    this.bot.use(this.observatoryPostMenu);
  }

  private async publishPost(ctx: BotContext, mode: PublicationModesEnum): Promise<void> {
    if (!this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
      return;
    }

    const imageHash = await this.deduplicationService.getPostImageHash(
      ctx?.callbackQuery?.message?.photo
    );
    const publishContext: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: ctx.callbackQuery.message.message_id,
      processedByModerator: ctx.callbackQuery.from.id,
      caption: ctx.callbackQuery?.message?.caption,
      isUserPost: false,
      hash: imageHash,
    };
    return this.publishWithContext(mode, publishContext);
  }

  private publishWithContext(
    mode: PublicationModesEnum,
    publishContext: ScheduledPostContextInterface
  ) {
    switch (mode) {
      case PublicationModesEnum.NOW_SILENT:
        return this.onPublishNow(publishContext);
      case PublicationModesEnum.NEXT_MORNING:
      case PublicationModesEnum.NEXT_MIDDAY:
      case PublicationModesEnum.NEXT_EVENING:
      case PublicationModesEnum.NEXT_INTERVAL:
      case PublicationModesEnum.NEXT_NIGHT:
        return this.publishScheduled(publishContext);
      case PublicationModesEnum.NIGHT_CRINGE:
        return this.publishNightCringeScheduled(publishContext);
    }
  }

  public async onPublishNow(publishContext: ScheduledPostContextInterface): Promise<void> {
    let caption = '';
    if (publishContext.mode === PublicationModesEnum.NIGHT_CRINGE) {
      const channelHtmlLink = await this.settingsService.cringeChannelHtmlLink();
      caption += [publishContext.caption, channelHtmlLink].filter((item) => !!item).join('\n');
    } else {
      const channelHtmlLink = await this.settingsService.channelHtmlLinkIfPrivate();
      caption += [publishContext.caption, channelHtmlLink].filter((item) => !!item).join('\n');
    }

    const publishedMessage = await this.bot.api.copyMessage(
      this.baseConfigService.memeChanelId,
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      {
        caption: caption,
        parse_mode: 'HTML',
        disable_notification: true,
      }
    );

    await this.observatoryPostRepository.update(
      { requestChannelMessageId: publishContext.requestChannelMessageId },
      {
        publishedMessageId: publishedMessage.message_id,
        isApproved: true,
        processedByModerator: { id: publishContext.processedByModerator },
      }
    );

    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });

    const url = await this.settingsService.channelLinkUrl();
    const inlineKeyboard = new InlineKeyboard().url(`🤖 Опубликован (${user.username})`, url).row();

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

  /**
   * Отправляет пост в Mattermost параллельно с основной публикацией в Telegram.
   */
  private async sendToMattermost(requestChannelMessageId: number, caption: string): Promise<void> {
    try {
      const fileUrl = await this.getTelegramFileUrl(requestChannelMessageId);
      await this.mattermostService.sendPostWithFile({
        message: caption,
        fileUrl,
        fileName: `observatory_meme_${requestChannelMessageId}`,
      });
    } catch (error) {
      this.logger.error('Failed to send to Mattermost:', error);
    }
  }

  /**
   * Получает прямую ссылку на файл из Telegram по ID сообщения в буферном канале.
   * Использует grammy bot.api.forwardMessage для получения структуры сообщения с file_id.
   */
  private async getTelegramFileUrl(messageId: number): Promise<string | undefined> {
    try {
      const chatId = this.baseConfigService.userRequestMemeChannel;
      const token = this.baseConfigService.botToken;

      const forwarded = await this.bot.api.forwardMessage(chatId, chatId, messageId, {
        disable_notification: true,
      });

      let fileId: string | undefined;

      if (forwarded.photo) {
        fileId = forwarded.photo[forwarded.photo.length - 1].file_id;
      } else if (forwarded.video) {
        fileId = forwarded.video.file_id;
      } else if (forwarded.document) {
        fileId = forwarded.document.file_id;
      } else if (forwarded.animation) {
        fileId = forwarded.animation.file_id;
      }

      if (!fileId) return undefined;

      const file = await this.bot.api.getFile(fileId);
      if (!file?.file_path) return undefined;

      const tgEnv = this.baseConfigService.tgEnv;
      if (tgEnv === 'test') {
        return `https://api.telegram.org/file/bot${token}/test/${file.file_path}`;
      }
      return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    } catch (error) {
      this.logger.error('Failed to get Telegram file URL:', error);
      return undefined;
    }
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
    const user = await this.userService.repository.findOne({
      where: { id: publishContext.processedByModerator },
    });
    const dateFormatted = format(
      PostSchedulerService.formatToMsk(publishDate),
      'dd.LL.yy в ~HH:mm'
    );

    const inlineKeyboard = new InlineKeyboard()
      .text(`⏰ ${dateFormatted} (${user.username})`)
      .row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );

    return Promise.resolve();
  }

  private async rejectObserverPost(ctx: BotContext): Promise<void> {
    await this.observatoryPostRepository.update(
      { requestChannelMessageId: ctx.callbackQuery.message.message_id },
      {
        isApproved: false,
        processedByModerator: { id: ctx.callbackQuery.from.id },
      }
    );

    const inlineKeyboard = new InlineKeyboard()
      .text(
        `🤖 Отклонен ❌ (${ctx.callbackQuery.from.username})`,
        ObservatoryPostMenusEnum.DELETE_OBSERVER_POST
      )
      .row();
    await ctx.editMessageReplyMarkup({ reply_markup: inlineKeyboard });
  }

  private waitDeleteObserverPost(): void {
    this.bot.callbackQuery(ObservatoryPostMenusEnum.DELETE_OBSERVER_POST, async (ctx) => {
      if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_DELETE_REJECTED_POST)) {
        await ctx.deleteMessage();
      }
    });
  }

  private async moderateViaUsers(ctx: BotContext, mode: PublicationModesEnum): Promise<void> {
    const imageHash = await this.deduplicationService.getPostImageHash(
      ctx?.callbackQuery?.message?.photo
    );
    const publishContext: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: ctx.callbackQuery.message.message_id,
      processedByModerator: ctx.callbackQuery.from.id,
      isUserPost: false,
      hash: imageHash,
    };

    const count = await this.userModeratedPostService.moderateViaUsers(ctx, publishContext);
    const inlineKeyboard = new InlineKeyboard().text(`👷 Модерируют пользователи (${count})`).row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );
  }
}
