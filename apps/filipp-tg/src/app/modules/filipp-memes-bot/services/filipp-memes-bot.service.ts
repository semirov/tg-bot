import { OnModuleInit, UseFilters } from '@nestjs/common';
import {
  Action,
  Ctx,
  InjectBot,
  Message,
  On,
  Start,
  Update,
} from 'nestjs-telegraf';
import { TelegrafExceptionFilter } from '../filters/telegraf-exception.filter';
import { HELLO_SCENE_ID } from '../scenes/hello.scene';
import { Context } from '../interfaces/context.interface';
import { Telegraf } from 'telegraf';
import { MEME_BOT } from '../filipp-meme-bot.const';
import { SEND_MEME_SCENE } from '../scenes/send-meme.scene';
import { REQUEST_ADMIN_SCENE } from '../scenes/request-admin.scene';

@Update()
@UseFilters(TelegrafExceptionFilter)
export class FilippMemesBotService implements OnModuleInit {
  constructor(
    @InjectBot(MEME_BOT)
    private readonly bot: Telegraf<Context>
  ) {}

  async onModuleInit(): Promise<void> {
    return void this.bot.telegram.setMyCommands([
      {
        command: 'start',
        description: 'Начать работу',
      },
    ]);
  }

  @Action('leave_scene')
  async onLeaveScene(@Ctx() ctx: Context) {
    await ctx.deleteMessage();
    await ctx.scene.enter(HELLO_SCENE_ID);
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

  @Start()
  async onStartUser(
    @Ctx() ctx: Context,
    @Message() message: Context['message']
  ): Promise<void> {
    if (message.chat.type === 'private') {
      await ctx.reply('Привет! 👋\n\n' + 'Это бот канала Филиповы мемы\n\n');
      return void ctx.scene.enter(HELLO_SCENE_ID);
    }
    return this.sendNonPrivateMessage(ctx);
  }

  private async sendNonPrivateMessage(ctx: Context) {
    return void ctx.reply('Я работаю только в личных сообщениях', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Напиши мне', url: `https://t.me/${ctx.botInfo.username}` }],
        ],
      },
    });
  }

  @On('message')
  async onSceneMessage(@Ctx() ctx: Context): Promise<void> {
    await ctx.scene.enter(HELLO_SCENE_ID);
  }

  @On('voice')
  onVoice(): string {
    return 'Голосовое?\nСерьезно?\nЯ же бот, у меня нет ушей.';
  }
}
