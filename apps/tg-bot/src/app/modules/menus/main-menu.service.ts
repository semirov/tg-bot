import {Inject, Injectable} from '@nestjs/common';
import {Menu} from '@grammyjs/menu';
import {UserMenusEnum} from './constants/bot-menus.enum';
import {BOT} from '../bot/providers/bot.provider';
import {Bot, CommandContext} from 'grammy';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {AdminMenuService} from './admin-menu.service';
import {ModeratorMenuService} from './moderator-menu.service';
import {ConversationsEnum} from "../post-management/constants/conversations.enum";

@Injectable()
export class MainMenuService {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private adminMenuService: AdminMenuService,
    private moderatorStartMenuService: ModeratorMenuService
  ) {
  }

  private userStartMenu: Menu<BotContext>;
  private adminStartMenu: Menu<BotContext>;
  private moderatorStartMenu: Menu<BotContext>;

  private buildStartUserMenu(): Menu<BotContext> {
    const menu = new Menu<BotContext>(UserMenusEnum.USER_START_MENU)
      .text('Прислать мем', (ctx) =>
        ctx.conversation.enter(ConversationsEnum.SEND_MEME_CONVERSATION)
      )
      .row()
      .submenu('Настройки', 'main-settings-menu')
      .row()
      .text('Связаться с админом', async (ctx) => {
        await ctx.conversation.enter(ConversationsEnum.USER_ADMIN_CONVERSATION);
      })
      .row()
      .url('Перейти в канал', 'https://t.me/filipp_memes');

    const settings = new Menu<BotContext>('main-settings-menu')
      .text(
        (ctx) =>
          ctx.session.anonymousPublishing ? '🙈️ Публикуюсь анонимно' : '👁️ Публикуюсь не анонимно',
        (ctx) => {
          ctx.session.anonymousPublishing = !ctx.session.anonymousPublishing;
          ctx.menu.update();
        }
      )
      .row()
      .back('Назад');

    menu.register(settings);

    return menu;
  }

  public getRoleBasedStartMenu(ctx: CommandContext<BotContext> | BotContext): Menu {
    switch (true) {
      case ctx.config.isOwner:
        return this.adminStartMenu;
      case ctx.config?.user?.isModerator:
        return this.moderatorStartMenu;
      default:
        return this.userStartMenu;
    }
  }

  public initStartMenu(): void {
    this.userStartMenu = this.buildStartUserMenu();
    this.moderatorStartMenu = this.moderatorStartMenuService.buildStartModeratorMenu(this.userStartMenu);
    this.adminStartMenu = this.adminMenuService.buildStartAdminMenu(
      this.userStartMenu,
      this.moderatorStartMenu
    );
    this.bot.use(this.userStartMenu);
    this.bot.use(this.moderatorStartMenu);
    this.bot.use(this.adminStartMenu);
  }
}
