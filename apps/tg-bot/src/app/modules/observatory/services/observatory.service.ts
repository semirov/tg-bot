import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {Menu} from '@grammyjs/menu';
import {BotContext} from '../../bot/interfaces/bot-context.interface';
import {MemeModerationMenusEnum} from '../../conversations/constants/meme-moderation-menus.enum';
import {UserPermissionEnum} from '../../bot/constants/user-permission.enum';
import {UserService} from '../../bot/services/user.service';
import {Bot, InlineKeyboard} from "grammy";
import {BOT} from "../../bot/providers/bot.provider";
import {BaseConfigService} from "../../config/base-config.service";
import {UserRequestService} from "../../bot/services/user-request.service";
import {ClientBaseService} from "../../client/services/client-base.service";

@Injectable()
export class ObservatoryService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userService: UserService,
    private userRequestService: UserRequestService,
    private clientBaseService: ClientBaseService
  ) {
  }

  /**
   * Меню публикации одобренного поста
   */
  private observerPostMenu: Menu<BotContext>;

  public onModuleInit(): void {
    this.buildObservatoryPostMenu();
    this.onObserverStationPost();
  }


  private onObserverStationPost() {
    this.clientBaseService.observerChannelPost$.subscribe(async (ctx) => {
      await ctx.api.copyMessage(
        this.baseConfigService.userRequestMemeChannel,
        ctx.channelPost.sender_chat.id,
        ctx.channelPost.message_id,
        {disable_notification: true, caption: '', reply_markup: this.observerPostMenu}
      );
    });
  }

  private buildObservatoryPostMenu(): void {
    this.observerPostMenu = new Menu<BotContext>(MemeModerationMenusEnum.OBSERVATORY_POST, {
      autoAnswer: false,
    })
      .text('🤖 Пост обсерватории')
      .row()
      .text('Отклонить', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_DELETE_REJECTED_POST)) {
          await this.rejectObserverPost(ctx);
        }
      })
      .text('Опубликовать', async (ctx) => {
        if (this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL)) {
          await this.publishObserverPost(ctx);
        }
      })
      .row();
    this.bot.use(this.observerPostMenu);
  }


  private async publishObserverPost(ctx: BotContext): Promise<void> {
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

    const postLink = channelInfo['username']
      ? `https://t.me/${channelInfo['username']}/${publishedMessage.message_id}`
      : channelInfo['invite_link'];

    const inlineKeyboard = new InlineKeyboard().url('🤖 Опубликован', postLink).row();
    await ctx.editMessageReplyMarkup({reply_markup: inlineKeyboard});
  }

  private async rejectObserverPost(ctx: BotContext): Promise<void> {
    await ctx.deleteMessage();
  }
}
