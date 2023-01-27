import {
  Scene,
  SceneEnter,
  SceneLeave,
  Command,
  Ctx,
  Action,
  On,
  Message,
} from 'nestjs-telegraf';
import { Context } from '../interfaces/context.interface';
import { HELLO_SCENE_ID } from './hello.scene';
import { AdminDialogManagementService } from '../services/admin-dialog-management.service';

export const REQUEST_ADMIN_SCENE = 'REQUEST_ADMIN_SCENE';
@Scene(REQUEST_ADMIN_SCENE)
export class RequestAdminScene {
  constructor(
    private adminDialogManagementService: AdminDialogManagementService
  ) {}
  @SceneEnter()
  async onSceneEnter(@Ctx() ctx: Context): Promise<void> {
    const text =
      'Напиши сообщение и админ тебе ответит через бота, как только сможет';
    const message = await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Вернуться назад', callback_data: 'leave_scene' }],
        ],
      },
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

    if (!message['text']) {
      ctx.reply(
        'Можем передать только текстовое сообщение, попробуй написать еще раз'
      );
      return;
    }

    await this.adminDialogManagementService.handleMessageToAdmin(message);

    await ctx.reply(
      'Твое сообщение передано, тебе ответят через некоторое время'
    );
    await ctx.scene.leave();
    await ctx.scene.enter(HELLO_SCENE_ID);
  }
}
