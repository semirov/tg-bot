import {forwardRef, Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {MainMenuService} from './modules/menus/main-menu.service';
import {BOT} from './modules/bot/providers/bot.provider';
import {Bot, CommandContext} from 'grammy';
import {BotContext} from './modules/bot/interfaces/bot-context.interface';
import {BaseConfigService} from './modules/config/base-config.service';
import {SendMemeConversation} from './modules/conversations/send-meme.conversation';
import {UserService} from './modules/bot/services/user.service';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    private mainMenuService: MainMenuService,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private sendMemeConversation: SendMemeConversation,
    private userService: UserService
  ) {
  }

  public onModuleInit(): void {
    this.mainMenuService.initStartMenu();
    this.onStartCommand();
    this.onMenuCommand();
    this.onMemeFromMain();
  }

  private onMenuCommand() {
    this.bot.command(['menu'], async (ctx: CommandContext<BotContext>) => {
      await ctx.reply('Выбери то, что хочешь сделать', {
        reply_markup: this.mainMenuService.getRoleBasedStartMenu(ctx),
      });
      await this.userService.updateUserLastActivity(ctx);
    });
  }

  private onStartCommand() {
    this.bot.command(['start'], async (ctx) => {
      const channelInfo = await ctx.api.getChat(
        this.baseConfigService.memeChanelId
      );
      const link = channelInfo['username']
        ? `https://t.me/${channelInfo['username']}`
        : channelInfo['invite_link'];

      const text =
        'Привет, это бот канала' +
        ` <a href="${link}">${channelInfo['title']}</a>\n\n` +
        'Можешь прислать мем\n' +
        'или нажми /menu, чтобы показать основное меню бота\n\n' +
        `Если хочешь, чтобы твой мем опубликовали ${
          ctx.session.anonymousPublishing ? 'публично' : 'анонимно'
        },` +
        ' то это можно включить в настройках в меню бота';
      await ctx.reply(text, {parse_mode: 'HTML'});
      await this.userService.updateUserLastActivity(ctx);
    });
  }

  private onMemeFromMain() {
    this.bot.on(['message:photo', 'message:video'], async (ctx) => {
      await this.userService.updateUserLastActivity(ctx);
      await this.sendMemeConversation.handleUserMemeRequest(ctx);
    });

    this.bot.on(
      ['message:text', 'message:document', 'message:voice', 'message:sticker'],
      async (ctx) => {
        await this.userService.updateUserLastActivity(ctx);
        await ctx.reply(
          'К публикации принимаются только картинки и видео\nЕсли тебе нужно что-то другое\nнажми /menu'
        );
      }
    );

    this.bot.on('channel_post', ctx => console.log(ctx.channelPost.sender_chat.id));
  }
}
