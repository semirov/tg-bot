import {Inject, Injectable, OnApplicationBootstrap, OnModuleInit} from '@nestjs/common';
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

@Injectable()
export class ObservatoryService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService,
    private clientBaseService: ClientBaseService,
    @InjectRepository(ObservatoryPostEntity)
    private observatoryPostRepository: Repository<ObservatoryPostEntity>
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
      .text('Отклонить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.rejectObserverPost(ctx);
        }
      })
      .text('Опубликовать', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)) {
          await this.publishObservatoryPost(ctx);
        }
      })
      .row();
    this.bot.use(this.observatoryPostMenu);
  }

  private async publishObservatoryPost(ctx: BotContext): Promise<void> {
    const channelInfo = await ctx.api.getChat(this.baseConfigService.memeChanelId);
    const link = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}`
      : channelInfo['invite_link'];
    const caption = `<a href="${link}">${channelInfo['title']}</a>`;

    const publishedMessage = await ctx.api.copyMessage(
      this.baseConfigService.memeChanelId,
      this.baseConfigService.userRequestMemeChannel,
      ctx.callbackQuery.message.message_id,
      {
        caption: caption,
        parse_mode: 'HTML',
        disable_notification: true,
      }
    );

    await this.observatoryPostRepository.update(
      {requestChannelMessageId: ctx.callbackQuery.message.message_id},
      {
        publishedMessageId: publishedMessage.message_id,
        isApproved: true,
        processedByModerator: {id: ctx.callbackQuery.from.id},
      }
    );

    const postLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}/${publishedMessage.message_id}`
      : channelInfo['invite_link'];

    const inlineKeyboard = new InlineKeyboard()
      .url(`🤖 Опубликован (${ctx.callbackQuery.from.username})`, postLink)
      .row();
    await ctx.editMessageReplyMarkup({reply_markup: inlineKeyboard});
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
