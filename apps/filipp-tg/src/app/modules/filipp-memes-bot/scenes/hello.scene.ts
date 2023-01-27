import { Scene, SceneEnter, Ctx, InjectBot } from 'nestjs-telegraf';
import { Context } from '../interfaces/context.interface';
import { MEME_BOT } from '../filipp-meme-bot.const';
import { Telegraf } from 'telegraf';
import {BaseConfigService} from "../../../config/base-config.service";

export const HELLO_SCENE_ID = 'HELLO_SCENE_ID';
@Scene(HELLO_SCENE_ID)
export class HelloScene {
  constructor(
    private configService: BaseConfigService
  ) {}
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
              url: `https://t.me/${this.configService.memeChatName}`,
            },
          ],
        ],
      },
    });
  }
}
