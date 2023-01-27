import { OnModuleInit, UseFilters } from '@nestjs/common';
import { Action, Ctx, InjectBot, Update } from 'nestjs-telegraf';
import { TelegrafExceptionFilter } from '../filters/telegraf-exception.filter';
import { Context } from '../interfaces/context.interface';
import { Telegraf } from 'telegraf';
import { MEME_BOT } from '../filipp-meme-bot.const';
import { environment } from '../../../../environments/environment';
import { Update as TelegramUpdate } from 'telegraf/typings/core/types/typegram';
import { CommonService } from './common.service';
import { ADMIN_DIALOG_SCENE } from '../scenes/admin-dialog.scene';
import {BaseConfigService} from "../../../config/base-config.service";

@Update()
@UseFilters(TelegrafExceptionFilter)
export class AdminDialogManagementService {
  constructor(
    @InjectBot(MEME_BOT)
    private readonly bot: Telegraf<Context>,
  private baseConfigService: BaseConfigService
  ) {}

  private adminIds = this.baseConfigService.adminIds;

  public async handleMessageToAdmin(
    message: Context['message']
  ): Promise<void> {
    const randomAdminId = CommonService.getRandomValueFromArray(this.adminIds);

    const forward = await this.bot.telegram.forwardMessage(
      randomAdminId,
      message.chat.id,
      message.message_id
    );
    const text = 'Новое обращение от пользователя';
    await this.bot.telegram.sendMessage(randomAdminId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Ответить',
              callback_data: `admin_dialog_start&${forward.message_id}&${message.chat.id}&${message.message_id}`,
            },
          ],
        ],
      },
    });
  }

  @Action(/admin_dialog_start/)
  async onAdminRejectMeme(
    @Ctx() ctx: Context & { update: TelegramUpdate.CallbackQueryUpdate }
  ) {
    const data = ctx.update.callback_query && ctx.update.callback_query['data'];
    const [, /**/ forwardMessageId, userChatId, originalMessageId] = (
      data || ''
    ).split('&');

    await ctx.deleteMessage();
    await ctx.scene.enter(ADMIN_DIALOG_SCENE, {
      forwardMessageId: +forwardMessageId,
      userChatId: +userChatId,
      originalMessageId: +originalMessageId,
    });
  }
}
