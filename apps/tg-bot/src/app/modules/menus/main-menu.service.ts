import {Inject, Injectable} from '@nestjs/common';
import {Menu} from '@grammyjs/menu';
import {
  AdminMenusEnum,
  ModeratorMenusEnum,
  UserMenusEnum,
} from './constants/bot-menus.enum';
import {BOT} from '../bot/providers/bot.provider';
import {Bot, CommandContext} from 'grammy';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {ConversationsEnum} from '../conversations/constants/conversations.enum';
import {AdminMenuService} from "./admin-menu.service";

@Injectable()
export class MainMenuService {
  constructor(@Inject(BOT) private bot: Bot<BotContext>, private adminMenuService: AdminMenuService) {
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
      // .text('Связаться с админом', (ctx) =>
      //   ctx.conversation.enter(ConversationsEnum.USER_ADMIN_DIALOG_CONVERSATION)
      // )
      // .row() // TODO
      .submenu('Настройки', 'main-settings-menu')
      .row()
      .url('Перейти в канал', 'https://t.me/filipp_memes');

    const settings = new Menu<BotContext>('main-settings-menu')
      .text(
        (ctx) =>
          ctx.session.anonymousPublishing
            ? '🙈️ Публикуюсь анонимно'
            : '👁️ Публикуюсь не анонимно',
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


  private buildStartModeratorMenu(): Menu<BotContext> {
    return new Menu<BotContext>(ModeratorMenusEnum.MODERATOR_START_MENU)
      .text('Модераторское меню', (ctx) => ctx.reply('Hi!'))
      .row()
      .url('Перейти в канал', 'https://t.me/filipp_memes')
      .row();
  }

  public getRoleBasedStartMenu(
    ctx: CommandContext<BotContext> | BotContext
  ): Menu {
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
    this.moderatorStartMenu = this.buildStartModeratorMenu();
    this.adminStartMenu = this.adminMenuService.buildStartAdminMenu(this.userStartMenu);
    this.bot.use(this.userStartMenu);
    this.bot.use(this.moderatorStartMenu);
    this.bot.use(this.adminStartMenu);
  }
}
