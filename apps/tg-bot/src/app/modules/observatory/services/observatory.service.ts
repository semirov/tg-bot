import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {Menu} from '@grammyjs/menu';
import {BotContext} from '../../bot/interfaces/bot-context.interface';
import {UserPermissionEnum} from '../../bot/constants/user-permission.enum';
import {UserService} from '../../bot/services/user.service';
import {Bot, InlineKeyboard} from 'grammy';
import {BOT} from '../../bot/providers/bot.provider';
import {BaseConfigService} from '../../config/base-config.service';
import {UserRequestService} from '../../bot/services/user-request.service';
import {ClientBaseService} from '../../client/services/client-base.service';
import {ObservatoryPostMenusEnum} from '../contsants/observatory-post-menus.enum';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {ObservatoryPostEntity} from '../entities/observatory-post.entity';
import {PublicationModesEnum} from '../../post-management/constants/publication-modes.enum';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../../bot/services/post-scheduler.service';
import {formatInTimeZone} from 'date-fns-tz';
import {ru} from 'date-fns/locale';

@Injectable()
export class ObservatoryService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService,
    private clientBaseService: ClientBaseService,
    @InjectRepository(ObservatoryPostEntity)
    private observatoryPostRepository: Repository<ObservatoryPostEntity>,
    private postSchedulerService: PostSchedulerService
  ) {
  }

  /**
   * Меню публикации одобренного поста
   */
  private observatoryPostMenu: Menu<BotContext>;

  public onModuleInit(): void {
    this.onNewObservatoryPost();
    this.waitDeleteObserverPost();
    this.buildObservatoryPostMenu();
  }

  private onNewObservatoryPost() {
    this.clientBaseService.observerChannelPost$.subscribe(async (ctx) => {
      const message = await ctx.api.copyMessage(
        this.baseConfigService.userRequestMemeChannel,
        ctx.channelPost.sender_chat.id,
        ctx.channelPost.message_id,
        {disable_notification: true, caption: '', reply_markup: this.observatoryPostMenu}
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
      .row();

    const publishSubmenu = new Menu<BotContext>(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, {
      autoAnswer: false,
    })
      .text('В очередь', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.IN_QUEUE)
      )
      .text('Сейчас 🔕', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.NOW_SILENT)
      )
      .text('Сейчас 🔔', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.NOW_WITH_ALARM)
      )
      .row()
      .text('Ночью', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.NEXT_NIGHT)
      )
      .text('Утром', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.NEXT_MORNING)
      )
      .text('Днем', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.NEXT_MIDDAY)
      )
      .text('Вечером', async (ctx) =>
        this.publishObservatoryPost(ctx, PublicationModesEnum.NEXT_EVENING)
      )
      .row()
      .text('Назад', (ctx) => ctx.menu.nav(ObservatoryPostMenusEnum.POST_MENU));

    this.observatoryPostMenu.register(publishSubmenu);

    this.bot.use(this.observatoryPostMenu);
  }

  private async publishObservatoryPost(ctx: BotContext, mode: PublicationModesEnum): Promise<void> {
    if (!this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
      return;
    }

    const publishContext: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: ctx.callbackQuery.message.message_id,
      processedByModerator: ctx.callbackQuery.from.id,
      caption: ctx.callbackQuery?.message?.caption,
      isUserPost: false,
    };

    switch (mode) {
      case PublicationModesEnum.NOW_SILENT:
      case PublicationModesEnum.NOW_WITH_ALARM:
        return this.onPublishNow(publishContext);
      case PublicationModesEnum.IN_QUEUE:
      case PublicationModesEnum.NEXT_MORNING:
      case PublicationModesEnum.NEXT_MIDDAY:
      case PublicationModesEnum.NEXT_EVENING:
      case PublicationModesEnum.NEXT_NIGHT:
        return this.publishScheduled(publishContext);
    }
  }

  public async onPublishNow(publishContext: ScheduledPostContextInterface): Promise<void> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const link = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];
    const caption = `<a href="${link}">${channelInfo['title']}</a>`;

    const publishedMessage = await this.bot.api.copyMessage(
      this.baseConfigService.memeChanelId,
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      {
        caption: caption,
        parse_mode: 'HTML',
        disable_notification: publishContext.mode === PublicationModesEnum.NOW_SILENT,
      }
    );

    await this.observatoryPostRepository.update(
      {requestChannelMessageId: publishContext.requestChannelMessageId},
      {
        publishedMessageId: publishedMessage.message_id,
        isApproved: true,
        processedByModerator: {id: publishContext.processedByModerator},
      }
    );

    const postLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}/${publishedMessage.message_id}`
      : channelInfo['invite_link'];

    const user = await this.userService.repository.findOne({
      where: {id: publishContext.processedByModerator},
    });

    const inlineKeyboard = new InlineKeyboard()
      .url(`🤖 Опубликован (${user.username})`, postLink)
      .row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      {reply_markup: inlineKeyboard}
    );
  }

  private async publishScheduled(publishContext: ScheduledPostContextInterface): Promise<void> {
    const publishDate = await this.postSchedulerService.addPostToSchedule(publishContext);
    const user = await this.userService.repository.findOne({
      where: {id: publishContext.processedByModerator},
    });
    const dateFormatted = formatInTimeZone(publishDate, 'Europe/Moscow', 'dd.LL.yy в ~HH:mm', {
      locale: ru,
    });

    const inlineKeyboard = new InlineKeyboard()
      .text(`⏰ ${dateFormatted} (${user.username})`)
      .row();

    await this.bot.api.editMessageReplyMarkup(
      this.baseConfigService.userRequestMemeChannel,
      publishContext.requestChannelMessageId,
      {reply_markup: inlineKeyboard}
    );

    return Promise.resolve();
  }

  private async rejectObserverPost(ctx: BotContext): Promise<void> {
    await this.observatoryPostRepository.update(
      {requestChannelMessageId: ctx.callbackQuery.message.message_id},
      {
        isApproved: false,
        processedByModerator: {id: ctx.callbackQuery.from.id},
      }
    );

    const inlineKeyboard = new InlineKeyboard()
      .text(
        `🤖 Отклонен ❌ (${ctx.callbackQuery.from.username})`,
        ObservatoryPostMenusEnum.DELETE_OBSERVER_POST
      )
      .row();
    await ctx.editMessageReplyMarkup({reply_markup: inlineKeyboard});
  }

  private waitDeleteObserverPost(): void {
    this.bot.callbackQuery(ObservatoryPostMenusEnum.DELETE_OBSERVER_POST, async (ctx) => {
      if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_DELETE_REJECTED_POST)) {
        await ctx.deleteMessage();
      }
    });
  }
}
