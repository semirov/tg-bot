import {
  Scene,
  SceneEnter,
  Ctx,
  On,
  Message,
  InjectBot,
} from 'nestjs-telegraf';
import { Context } from '../interfaces/context.interface';
import { MEME_BOT } from '../filipp-meme-bot.const';
import { Telegraf } from 'telegraf';

export const ADMIN_DIALOG_SCENE = 'ADMIN_DIALOG_SCENE';
@Scene(ADMIN_DIALOG_SCENE)
export class AdminDialogScene {
  constructor(
    @InjectBot(MEME_BOT)
    private readonly bot: Telegraf<Context>
  ) {}
  @SceneEnter()
  async onSceneEnter(@Ctx() ctx: Context): Promise<void> {
    const message = await ctx.reply('Ответь пользователю сообщением');
    ctx.scene.session.state = { ...ctx.scene.session.state, previousMessage: message.message_id };
  }

  @On('message')
  async onSceneMessage(
    @Ctx() ctx: Context,
    @Message() message: Context['message']
  ): Promise<void> {
    const { forwardMessageId, userChatId, originalMessageId } = ctx.session
      .__scenes.state as { forwardMessageId: number, userChatId: number, originalMessageId: number };

    await this.bot.telegram.forwardMessage(
      +userChatId,
      +userChatId,
      +originalMessageId
    );
    await this.bot.telegram.copyMessage(
      userChatId,
      message.chat.id,
      message.message_id,
    )

    if (ctx.scene.session.state['previousMessage']) {
      await ctx.deleteMessage(ctx.scene.session.state['previousMessage']);
      ctx.scene.session.state['previousMessage'] = null;
    }
    await ctx.scene.leave();
  }
}
