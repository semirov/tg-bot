import {Inject, Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';

@Injectable()
export class StartBotCommand {
  constructor(@Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>) {
  }

  public init(): void {
    this.bot.command('start', async (ctx: BotContext) => {
      const message =
        'Каналия - это мастер управления ботами для широкого набора возможностей, ' +
        'от управления каналами, до модерации групп и взаимодействия с большой аудиторией!\n\n' +
        'Нажми /newbot чтобы попробовать\n\n' +
        'Чтобы изучить все возможности, нажми /features\n' +
        'Обязательно прочитай условия обслуживания /therms_of_service';
      ctx.reply(message);
    });

    this.bot.command('therms_of_service', async (ctx: BotContext) => {
      const message = 'Бот в процессе разработки, функционал нестабилен, пользоваться нельзя';
      ctx.reply(message);
    });


    this.bot.command('features', async (ctx: BotContext) => {
      const message = 'Скоро бот научится делать потрясающие вещи!';
      ctx.reply(message);
    });
  }
}
