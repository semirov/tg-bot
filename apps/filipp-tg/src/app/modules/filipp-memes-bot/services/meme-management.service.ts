import { OnModuleInit, UseFilters } from '@nestjs/common';
import { Action, Ctx, InjectBot, Update } from 'nestjs-telegraf';
import { TelegrafExceptionFilter } from '../filters/telegraf-exception.filter';
import { Context } from '../interfaces/context.interface';
import { Telegraf } from 'telegraf';
import { MEME_BOT } from '../filipp-meme-bot.const';
import { environment } from '../../../../environments/environment';
import { Update as TelegramUpdate } from 'telegraf/typings/core/types/typegram';
import {CommonService} from "./common.service";
import {BaseConfigService} from "../../../config/base-config.service";

@Update()
@UseFilters(TelegrafExceptionFilter)
export class MemeManagementService {
  constructor(
    @InjectBot(MEME_BOT)
    private readonly bot: Telegraf<Context>,
    private baseConfigService: BaseConfigService
  ) {}

  private memeChannelId = this.baseConfigService.memeChanelId;
  private testChannelId = this.baseConfigService.testMemeChannel;
  private adminIds = this.baseConfigService.adminIds;
  private moderatorIds = this.baseConfigService.moderatorIds;

  public async sendMemeToApprove(message: Context['message']): Promise<void> {
    const approveMember = this.getRandomApproveMember();
    switch (approveMember.type) {
      case 'moderator':
        return this.approveViaModerator(
          message.chat.id,
          message.message_id,
          approveMember.userId
        );
      case 'admin':
      default:
        return this.approveViaAdmin(
          message.chat.id,
          message.message_id,
          approveMember.userId
        );
    }
  }

  private async approveViaAdmin(
    userChatId: number,
    userMemeMessageId: number,
    adminId: number,
    messageText = 'Кто-то предложил мем'
  ): Promise<void> {
    const forward = await this.bot.telegram.forwardMessage(
      adminId,
      userChatId,
      userMemeMessageId
    );
    await this.bot.telegram.sendMessage(adminId, messageText, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Отклонить',
              callback_data: `admin_reject_requested_meme&${forward.message_id}&${userChatId}&${userMemeMessageId}`,
            },
            {
              text: 'Опубликовать',
              callback_data: `admin_approve_requested_meme&${forward.message_id}&${userChatId}&${userMemeMessageId}`,
            },
          ],
          [
            {
              text: 'В тестовый канал',
              callback_data: `admin_send_to_test&${forward.message_id}&${userChatId}&${userMemeMessageId}`,
            },
          ]
        ],
      },
    });
  }

  private async approveViaModerator(
    userChatId: number,
    userMemeMessageId: number,
    moderatorId: number
  ): Promise<void> {
    const forward = await this.bot.telegram.forwardMessage(
      moderatorId,
      userChatId,
      userMemeMessageId
    );
    const message =
      'Этот мем прислал пользователь, его нужно одобрить или отклонить.' +
      'В случае одобрения, мем будет рассмотрен администратором';
    await this.bot.telegram.sendMessage(moderatorId, message, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Отклонить',
              callback_data: `admin_reject_requested_meme&${forward.message_id}&${userChatId}&${userMemeMessageId}`,
            },
            {
              text: 'Одобрить',
              callback_data: `moderator_approve_requested_meme&${forward.message_id}&${userChatId}&${userMemeMessageId}`,
            },
          ],
        ],
      },
    });
  }

  @Action(/moderator_approve_requested_meme/)
  async onModeratorApproveMeme(
    @Ctx() ctx: Context & { update: TelegramUpdate.CallbackQueryUpdate }
  ) {
    const data = ctx.update.callback_query && ctx.update.callback_query['data'];
    const [, /**/ forwardMessageId, chatId, userMemeMessageId] = (
      data || ''
    ).split('&');
    const adminId = CommonService.getRandomValueFromArray(this.adminIds);
    await this.approveViaAdmin(
      +chatId,
      +userMemeMessageId,
      adminId,
      'Модератор одобрил мем от пользователя'
    );

    await ctx.deleteMessage();
    await ctx.deleteMessage(+forwardMessageId);
  }

  @Action(/admin_reject_requested_meme/)
  async onAdminRejectMeme(
    @Ctx() ctx: Context & { update: TelegramUpdate.CallbackQueryUpdate }
  ) {
    const data = ctx.update.callback_query && ctx.update.callback_query['data'];
    const [, /**/ forwardMessageId, chatId, originalMessageId] = (
      data || ''
    ).split('&');

    await this.bot.telegram.forwardMessage(
      +chatId,
      +chatId,
      +originalMessageId
    );
    await this.bot.telegram.sendMessage(
      chatId,
      'Жаль, но твой мем отклонили, возможно он показался не смешным или были другие причины.'
    );

    await ctx.deleteMessage();
    await ctx.deleteMessage(+forwardMessageId);
  }

  @Action(/admin_approve_requested_meme/)
  async onAdminApproveMeme(
    @Ctx() ctx: Context & { update: TelegramUpdate.CallbackQueryUpdate }
  ) {
    const data = ctx.update.callback_query && ctx.update.callback_query['data'];
    const [, /**/ forwardMessageId, userChatId, userMemeMessageId] = (
      data || ''
    ).split('&');

    const userChat = await this.bot.telegram.getChat(userChatId);
    await this.bot.telegram.forwardMessage(
      +userChatId,
      +userChatId,
      +userMemeMessageId
    );
    await this.bot.telegram.sendMessage(
      userChatId,
      'Твой мем опубликован 😍\n' +
        'Спасибо что делишься смешными мемами, присылай еще! 😉\n' +
        'Можешь перейти в канал чтобы посмотреть',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Перейти в канал',
                url: `https://t.me/${this.baseConfigService.memeChatName}`,
              },
            ],
          ],
        },
      }
    );

    await this.bot.telegram.copyMessage(
      this.memeChannelId,
      +userChatId,
      +userMemeMessageId,
      {
        caption: `Мем предложил @${userChat['username']}`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Прислать мем',
                url: `https://t.me/${ctx.botInfo.username}`,
              },
            ],
          ],
        },
      }
    );

    await ctx.deleteMessage();
    await ctx.deleteMessage(+forwardMessageId);
  }


  @Action(/admin_send_to_test/)
  async onSendToTest(
    @Ctx() ctx: Context & { update: TelegramUpdate.CallbackQueryUpdate }
  ) {
    const data = ctx.update.callback_query && ctx.update.callback_query['data'];
    const [, /**/ forwardMessageId, userChatId, userMemeMessageId] = (
      data || ''
    ).split('&');

    const userChat = await this.bot.telegram.getChat(userChatId);

    await this.bot.telegram.copyMessage(
      this.testChannelId,
      +userChatId,
      +userMemeMessageId,
      {
        caption: `Мем предложил @${userChat['username']}`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Прислать мем',
                url: `https://t.me/${ctx.botInfo.username}`,
              },
            ],
          ],
        },
      }
    );
  }


  private getRandomApproveMember(): {
    userId: number;
    type: 'moderator' | 'admin';
  } {
    const types = CommonService.getRandomValueFromArray(['admin', 'moderator']);
    switch (types) {
      case 'moderator':
        return {
          userId: CommonService.getRandomValueFromArray(this.moderatorIds),
          type: 'moderator',
        };
      case 'admin':
      default:
        return {
          userId: CommonService.getRandomValueFromArray(this.adminIds),
          type: 'admin',
        };
    }
  }

}
