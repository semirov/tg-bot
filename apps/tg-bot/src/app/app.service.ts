import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {MainMenuService} from './modules/menus/main-menu.service';
import {BOT} from './modules/bot/providers/bot.provider';
import {Bot, CommandContext, InlineKeyboard} from 'grammy';
import {BotContext} from './modules/bot/interfaces/bot-context.interface';
import {BaseConfigService} from './modules/config/base-config.service';
import {UserService} from './modules/bot/services/user.service';
import {UserPostManagementService} from './modules/post-management/user-post-management.service';
import {ConversationsEnum} from './modules/post-management/constants/conversations.enum';
import {SettingsService} from './modules/bot/services/settings.service';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    private mainMenuService: MainMenuService,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userPostManagementService: UserPostManagementService,
    private userService: UserService,
    private settingsService: SettingsService
  ) {
  }

  public onModuleInit(): void {
    this.mainMenuService.initStartMenu();
    this.onAskAdmin();
    this.onStartCommand();
    this.onMenuCommand();
    this.onMemeFromMain();
    this.onNewMember();
  }

  private onAskAdmin() {
    this.bot.command('ask_admin', async (ctx) => {
      await ctx.conversation.enter(ConversationsEnum.USER_ADMIN_CONVERSATION);
    });
  }

  private onMenuCommand() {
    this.bot.command('menu', async (ctx: CommandContext<BotContext>) => {
      await ctx.reply('Выбери то, что хочешь сделать', {
        reply_markup: this.mainMenuService.getRoleBasedStartMenu(ctx),
      });
      await this.userService.updateUserLastActivity(ctx);
    });
  }

  private onStartCommand() {
    this.bot.command(['start'], async (ctx) => {
      const channelLink = await this.settingsService.channelHtmlLink();

      const text =
        'Привет, это бот канала' +
        ` ${channelLink}\n\n` +
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
      await this.userPostManagementService.handleUserMemeRequest(ctx);
    });

    this.bot.on(
      ['message:text', 'message:document', 'message:voice', 'message:sticker'],
      async (ctx) => {
        await this.userService.updateUserLastActivity(ctx);
        await ctx.reply(
          'К публикации принимаются только картинки и видео\n\nЕсли тебе нужно что-то другое нажми /menu' +
          '\n\nЕсли хочешь связаться с админом, нажми /ask_admin'
        );
      }
    );
  }

  private onNewMember() {
    this.bot.on(['chat_join_request'], async (ctx) => {
      const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
      const channelUrl = await this.settingsService.channelLinkUrl();
      let messageText = `Привет!\nДобро пожаловать в канал <b>${channelInfo['title']}</b>!`;
      messageText += '\n\nЕсли хочешь, чтобы твой мем опубликовали в канале, просто пришли его мне';
      const menu = new InlineKeyboard().url('Перейти в канал', channelUrl);
      await this.bot.api.sendMessage(ctx.chatJoinRequest.from.id, messageText, {
        reply_markup: menu,
        parse_mode: 'HTML',
      });
      const {first_name, last_name, username, is_bot, is_premium} = ctx.chatJoinRequest.from;

      const text = [
        'Новый подписчик:\n',
        is_premium ? '👑' : null,
        is_bot ? '🤖' : null,
        first_name,
        last_name,
        username ? `@${username}` : null,
      ].filter(v => !!v).join(' ');

      await ctx.approveChatJoinRequest(ctx.chatJoinRequest.from.id);
      await this.bot.api.sendMessage(this.baseConfigService.ownerId, text);
    });

    // this.bot.on('channel_post', (ctx) => console.log(ctx.channelPost.chat.id));
  }
}
