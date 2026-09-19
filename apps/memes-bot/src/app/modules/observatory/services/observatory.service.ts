import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Menu } from '@grammyjs/menu';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { UserPermissionEnum } from '../../bot/constants/user-permission.enum';
import { UserService } from '../../bot/services/user.service';
import { Bot } from 'grammy';
import { BOT } from '../../bot/providers/bot.provider';
import { BaseConfigService } from '../../config/base-config.service';
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
import { TrollService } from '../../troll/services/troll.service';
import { buildTelegramFileUrl, extractTelegramFileId } from '../../../shared/publication/media-url';
import { buildPostUrl, TelegramPostSource } from '../../../shared/publication/telegram-link';
import { sendPostToMattermost } from '../../../shared/publication/mattermost-post';
import { hasSimilarDistance } from '../../post-management/services/duplicate-policy';
import { ObservatoryPostFormatter } from './observatory-post-formatter';
import { ObservatoryPublishPolicy } from './observatory-publish-policy';

@Injectable()
export class ObservatoryService implements OnModuleInit {
  private readonly logger = new Logger(ObservatoryService.name);

  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    @InjectRepository(ObservatoryPostEntity)
    private observatoryPostRepository: Repository<ObservatoryPostEntity>,
    private postSchedulerService: PostSchedulerService,
    private settingsService: SettingsService,
    private cringeManagementService: CringeManagementService,
    private deduplicationService: DeduplicationService,
    private userModeratedPostService: UserModeratedPostService,
    private mattermostService: MattermostService,
    private trollService: TrollService
  ) {}

  /**
   * Меню публикации одобренного поста
   */
  private observatoryPostMenu: Menu<BotContext>;

  /** Чистые builder'ы сообщений и клавиатур обсерватории. */
  private readonly formatter = new ObservatoryPostFormatter();

  /** Маршрутизация публикации по режимам (seam над shared publication-mode). */
  private readonly publishPolicy = new ObservatoryPublishPolicy({
    now: (context) => this.onPublishNow(context),
    scheduled: (context) => this.publishScheduled(context),
    nightCringe: (context) => this.publishNightCringeScheduled(context),
  });

  public onModuleInit(): void {
    this.bot.use(this.userModeratedPostService.buildUserModeratePost());
    this.onNewUserModeratedPost();
    this.waitDeleteObserverPost();
    // Меню ставится через `bot.use` до обработчика парсера: обработчик отдаёт
    // пост в предложку с `reply_markup: observatoryPostMenu`, а grammY умеет
    // подменять меню на инлайн-клавиатуру только если middleware меню уже
    // прошёл раньше в цепочке апдейта. Иначе `copyMessage` падает с
    // «Did you forget to use bot.use() for it?».
    this.buildObservatoryPostMenu();
    this.onParserPost();
  }

  private onNewUserModeratedPost() {
    this.userModeratedPostService.userModeratedPost$.subscribe(async (ctx) => {
      await this.publishWithContext(ctx.mode, ctx);
    });
  }

  /**
   * Принимает пост от доверенного парсера: userbot форвардит найденный
   * медиапост боту в личку, бот кладёт его в предложку с подписью источника
   * и меню модерации.
   *
   * Канал-коллектор больше не нужен (TGB-34). Капчу и проверку подписки для
   * аккаунта-парсера пропускает `AppService`.
   */
  private onParserPost(): void {
    this.bot.on(['message:photo', 'message:video'], async (ctx, next) => {
      const parserUserId = this.baseConfigService.parserUserId;
      if (!parserUserId || ctx.chat?.type !== 'private' || ctx.from?.id !== parserUserId) {
        // Не наш случай: отдаём апдейт дальше (капча, предложка, тролль).
        return next();
      }
      this.logger.log(
        `Observatory: parsed post from parser (msg=${ctx.message?.message_id ?? 'n/a'})`
      );
      await this.onNewObservatoryPost(ctx);
    });
  }

  private async onNewObservatoryPost(ctx: BotContext): Promise<void> {
    const message = ctx?.message;
    if (!ctx?.chat || !message) {
      return;
    }

    const imageHash = await this.deduplicationService.getPostImageHash(message?.photo);
    const duplicates = await this.deduplicationService.checkDuplicate(imageHash);
    // если есть дубликат с похожестью больше 0.5 - выкидываем пост
    if (hasSimilarDistance(duplicates)) {
      return;
    }

    // Служебная подпись со ссылкой на исходный пост исходного канала.
    const source = this.resolveSource(message ?? null);
    const caption = this.formatter.sourceCaption(source);

    const copied = await ctx.api.copyMessage(
      this.baseConfigService.userRequestMemeChannel,
      ctx.chat.id,
      message.message_id,
      {
        disable_notification: true,
        caption,
        ...(caption ? { parse_mode: 'HTML' as const } : {}),
        reply_markup: this.observatoryPostMenu,
      }
    );

    const post = await this.observatoryPostRepository.create({
      requestChannelMessageId: copied.message_id,
      sourceChatId: source?.chatId ?? null,
      sourceMessageId: source?.messageId ?? null,
      sourceUsername: source?.username ?? null,
      sourceTitle: source?.title ?? null,
      sourceUrl: source?.url ?? null,
      originalCaption: message.caption ?? null,
    });
    await this.observatoryPostRepository.save(post);
  }

  /**
   * Извлекает источник из forward-заголовка присланного парсером сообщения.
   *
   * Сначала смотрит `forward_origin` (Bot API 7+), затем legacy-поля
   * `forward_from_chat` / `forward_from_message_id`.
   *
   * @param message сообщение от парсера
   * @returns источник поста или `null`, если заголовок недоступен
   */
  private resolveSource(message: {
    forward_origin?: { type?: string; chat?: unknown; message_id?: number };
    forward_from_chat?: unknown;
    forward_from_message_id?: number;
  } | null): TelegramPostSource | null {
    if (!message) {
      return null;
    }

    const origin = message.forward_origin;
    if (origin?.chat && (origin.type === 'channel' || origin.type === 'chat')) {
      return this.buildSource(origin.chat, origin.message_id ?? null);
    }

    if (message.forward_from_chat) {
      return this.buildSource(message.forward_from_chat, message.forward_from_message_id ?? null);
    }

    return null;
  }

  /**
   * Собирает описание источника: id/username/title и ссылку на пост.
   *
   * @param chat исходный канал (Bot API `Chat`)
   * @param messageId id исходного поста
   * @returns источник поста
   */
  private buildSource(chat: unknown, messageId: number | null): TelegramPostSource {
    const typed = chat as { id?: number; username?: string; title?: string };
    return {
      chatId: typeof typed?.id === 'number' ? typed.id : null,
      messageId,
      username: typed?.username ?? null,
      title: typed?.title ?? null,
      url: buildPostUrl({ id: typed?.id, username: typed?.username }, messageId),
    };
  }

  private buildObservatoryPostMenu(): void {
    this.observatoryPostMenu = new Menu<BotContext>(ObservatoryPostMenusEnum.POST_MENU, {
      autoAnswer: false,
    })
      .text(ObservatoryPostFormatter.POST_MENU_LABEL)
      .row()
      .text(ObservatoryPostFormatter.PUBLISH_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          ctx.menu.nav(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION);
        }
      })
      .text(ObservatoryPostFormatter.REJECT_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.rejectObserverPost(ctx);
        }
      })
      .row()
      .text(ObservatoryPostFormatter.MODERATE_BY_USERS_LABEL, async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          ctx.menu.nav(ObservatoryPostMenusEnum.USER_MODERATE_POST);
        }
      })
      .row();

    const publishSubmenu = new Menu<BotContext>(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, {
      autoAnswer: false,
    })
      .text(ObservatoryPostFormatter.PUBLISH_NIGHT_CRINGE_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NIGHT_CRINGE)
      )
      .text(ObservatoryPostFormatter.PUBLISH_NOW_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NOW_SILENT)
      )
      .row()
      .text(ObservatoryPostFormatter.PUBLISH_NEXT_INTERVAL_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_INTERVAL)
      )
      .row()
      .text(ObservatoryPostFormatter.PUBLISH_NIGHT_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_NIGHT)
      )
      .text(ObservatoryPostFormatter.PUBLISH_MORNING_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_MORNING)
      )
      .text(ObservatoryPostFormatter.PUBLISH_MIDDAY_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_MIDDAY)
      )
      .text(ObservatoryPostFormatter.PUBLISH_EVENING_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_EVENING)
      )
      .row()
      .text(ObservatoryPostFormatter.BACK_LABEL, (ctx) =>
        ctx.menu.nav(ObservatoryPostMenusEnum.POST_MENU)
      );

    const userModeratePost = new Menu<BotContext>(ObservatoryPostMenusEnum.USER_MODERATE_POST, {
      autoAnswer: false,
    })
      .text(ObservatoryPostFormatter.PUBLISH_NOW_LABEL, async (ctx) =>
        this.moderateViaUsers(ctx, PublicationModesEnum.NOW_SILENT)
      )
      .row()
      .text(ObservatoryPostFormatter.PUBLISH_NEXT_INTERVAL_LABEL, async (ctx) =>
        this.publishPost(ctx, PublicationModesEnum.NEXT_INTERVAL)
      )
      .row()
      .text(ObservatoryPostFormatter.PUBLISH_NIGHT_LABEL, async (ctx) =>
        this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_NIGHT)
      )
      .text(ObservatoryPostFormatter.PUBLISH_MORNING_LABEL, async (ctx) =>
        this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_MORNING)
      )
      .text(ObservatoryPostFormatter.PUBLISH_MIDDAY_LABEL, async (ctx) =>
        this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_MIDDAY)
      )
      .text(ObservatoryPostFormatter.PUBLISH_EVENING_LABEL, async (ctx) =>
        this.moderateViaUsers(ctx, PublicationModesEnum.NEXT_EVENING)
      )
      .row()
      .text(ObservatoryPostFormatter.BACK_LABEL, (ctx) =>
        ctx.menu.nav(ObservatoryPostMenusEnum.POST_MENU)
      );

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
    // Caption в предложке занят служебной подписью источника — в публикацию
    // он не переносится (к публикуемому посту добавляется только ссылка на канал).
    const publishContext: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: ctx.callbackQuery.message.message_id,
      processedByModerator: ctx.callbackQuery.from.id,
      isUserPost: false,
      hash: imageHash,
    };
    return this.publishWithContext(mode, publishContext);
  }

  /**
   * Тонкий делегат в `ObservatoryPublishPolicy`.
   */
  private publishWithContext(
    mode: PublicationModesEnum,
    publishContext: ScheduledPostContextInterface
  ) {
    return this.publishPolicy.run(mode, publishContext);
  }

  public async onPublishNow(publishContext: ScheduledPostContextInterface): Promise<void> {
    const channelHtmlLink =
      publishContext.mode === PublicationModesEnum.NIGHT_CRINGE
        ? await this.settingsService.cringeChannelHtmlLink()
        : await this.settingsService.channelHtmlLinkIfPrivate();
    const caption = this.formatter.composeCaption(publishContext.caption, channelHtmlLink);

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
    const inlineKeyboard = this.formatter.publishedKeyboard(user.username, url);

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

    // Иногда репостим новый мем в активные чаты (не блокирует публикацию).
    void this.trollService.maybeRepostMeme(
      this.baseConfigService.memeChanelId,
      publishedMessage.message_id
    );
  }

  /**
   * Отправляет пост в Mattermost параллельно с основной публикацией в Telegram.
   */
  private async sendToMattermost(requestChannelMessageId: number, caption: string): Promise<void> {
    return sendPostToMattermost({
      mattermostService: this.mattermostService,
      getFileUrl: (messageId) => this.getTelegramFileUrl(messageId),
      logger: this.logger,
      requestChannelMessageId,
      caption,
      fileNamePrefix: 'observatory_meme_',
    });
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

      const fileId = extractTelegramFileId(forwarded);

      if (!fileId) return undefined;

      const file = await this.bot.api.getFile(fileId);
      if (!file?.file_path) return undefined;

      return buildTelegramFileUrl(token, file.file_path, this.baseConfigService.tgEnv);
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

    const inlineKeyboard = this.formatter.scheduledKeyboard(dateFormatted, user.username);

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

    const inlineKeyboard = this.formatter.rejectedKeyboard(ctx.callbackQuery.from.username);
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
    const inlineKeyboard = this.formatter.moderatingUsersKeyboard(count);

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      { reply_markup: inlineKeyboard }
    );
  }
}
