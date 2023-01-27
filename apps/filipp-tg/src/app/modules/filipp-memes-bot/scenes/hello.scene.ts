import {
  Scene,
  SceneEnter,
  SceneLeave,
  Command,
  Ctx,
  Action,
} from 'nestjs-telegraf';
import { Context } from '../interfaces/context.interface';
import { SEND_MEME_SCENE } from './send-meme.scene';
import {REQUEST_ADMIN_SCENE} from "./request-admin.scene";

export const HELLO_SCENE_ID = 'HELLO_SCENE_ID';
@Scene(HELLO_SCENE_ID)
export class HelloScene {
  @SceneEnter()
  async onSceneEnter(@Ctx() context: Context): Promise<void> {
    const text = 'Выбери то, что хочешь сделать';
    await context.reply(text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Я хочу прислать мем', callback_data: 'meme_request' }],
          [
            {
              text: 'Я хочу связаться с админом',
              callback_data: 'admin_request',
            },
          ],
          [
            {
              text: 'Перейти в канал',
              url: 'https://t.me/filipp_memes',
            },
          ],
        ],
      },
    });
  }

  @Action('meme_request')
  async onMemeRequestAnswer(@Ctx() ctx: Context) {
    await ctx.deleteMessage();
    await ctx.scene.enter(SEND_MEME_SCENE);
  }

  @Action('admin_request')
  async onAdminRequestAnswer(@Ctx() ctx: Context) {
    await ctx.deleteMessage();
    await ctx.scene.enter(REQUEST_ADMIN_SCENE);
  }
}
