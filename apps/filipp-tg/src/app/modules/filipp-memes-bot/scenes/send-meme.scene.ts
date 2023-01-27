import { Scene, SceneEnter, Ctx, On, Message, Action } from 'nestjs-telegraf';
import { Context } from '../interfaces/context.interface';
import { HELLO_SCENE_ID } from './hello.scene';
import { MemeManagementService } from '../services/meme-management.service';
import { UseFilters } from '@nestjs/common';
import { TelegrafExceptionFilter } from '../filters/telegraf-exception.filter';

export const SEND_MEME_SCENE = 'SEND_MEME_SCENE';
@Scene(SEND_MEME_SCENE)
@UseFilters(TelegrafExceptionFilter)
export class SendMemeScene {
  constructor(private memeManagementService: MemeManagementService) {}
  @SceneEnter()
  async onSceneEnter(@Ctx() ctx: Context): Promise<void> {
    const text =
      'Просто пришли мем, который ты хочешь опубликовать, если будет смешно, то его опубликуют';
    const message = await ctx.reply(text, {
      reply_markup: this.commonMemeButtons,
    });

    ctx.scene.session.state = { previousMessage: message.message_id };
  }

  @On('message')
  async onSceneMessage(
    @Ctx() ctx: Context,
    @Message() message: Context['message']
  ): Promise<void> {
    if (ctx.scene.session.state['previousMessage']) {
      await ctx.deleteMessage(ctx.scene.session.state['previousMessage']);
      ctx.scene.session.state['previousMessage'] = null;
    }

    if (!this.checkAllowedContent(ctx, message)) {
      return;
    }

    await this.memeManagementService.sendMemeToApprove(message);

    await ctx.reply('Мем отправлен на одобрение 😎');
    await ctx.scene.leave();
    await ctx.scene.enter(HELLO_SCENE_ID);
  }

  @Action('show_rules')
  async onLeaveScene(@Ctx() ctx: Context) {
    const text =
      '<b>Для публикации принимаются:</b>\n' +
      '- Смешные картинки\n' +
      '- Смешные видео\n\n' +
      '<b>Мы можем изменить предложеный мем:</b>\n' +
      '- Подпись к картинкам или видео будет удалена\n' +
      '- Публикация может быть отклонена, если админу мем покажется не смешным\n' +
      '- Публикуемые мемы будут подписаны автором\n' +
      '- Мем может быть опубликован не сразу\n';
    await ctx.replyWithHTML(text);
  }

  private get commonMemeButtons() {
    return {
      inline_keyboard: [
        [{ text: 'Показать правила', callback_data: 'show_rules' }],
        [{ text: 'Вернуться назад', callback_data: 'leave_scene' }],
      ],
    };
  }

  private checkAllowedContent(
    ctx: Context,
    message: Context['message']
  ): boolean {
    if (message['voice']) {
      ctx.reply(
        'Голосовые сообщения не принимаются, извини.\nПопробуй прислать что-нибудь другое',
        {
          reply_markup: this.commonMemeButtons,
        }
      );
      return false;
    }

    if (message['sticker']) {
      ctx.reply(
        'Стикеры не принимаются, извини.\nПопробуй прислать что-нибудь другое',
        {
          reply_markup: this.commonMemeButtons,
        }
      );
      return false;
    }

    if (message['text']) {
      ctx.reply(
        'Просто текст, может даже и смешной, не принимается, извини.\nПопробуй прислать что-нибудь другое',
        {
          reply_markup: this.commonMemeButtons,
        }
      );
      return false;
    }

    if (message['video_note']) {
      ctx.reply(
        'Кружочки не принимается, извини.\nПопробуй прислать что-нибудь другое',
        {
          reply_markup: this.commonMemeButtons,
        }
      );
      return false;
    }

    if (message['animation']) {
      ctx.reply(
        'Гифки не принимаются, извини.\nПопробуй прислать что-нибудь другое',
        {
          reply_markup: this.commonMemeButtons,
        }
      );
      return false;
    }

    return true;
  }
}
