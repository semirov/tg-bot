import { Inject, Injectable } from '@nestjs/common';
import { Menu } from '@grammyjs/menu';
import { UserMenusEnum } from './constants/bot-menus.enum';
import { BOT } from '../bot/providers/bot.provider';
import { Bot, CommandContext } from 'grammy';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { AdminMenuService } from './admin-menu.service';
import { ModeratorMenuService } from './moderator-menu.service';
import { ConversationsEnum } from '../post-management/constants/conversations.enum';
import { UserService } from '../bot/services/user.service';

@Injectable()
export class MainMenuService {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private adminMenuService: AdminMenuService,
    private moderatorStartMenuService: ModeratorMenuService,
    private userService: UserService
  ) {}

  private userStartMenu: Menu<BotContext>;
  private adminStartMenu: Menu<BotContext>;
  private moderatorStartMenu: Menu<BotContext>;

  public readonly MEME_RULES =
    '<b>Для публикации принимаются:</b>\n' +
    '- Смешные и оригинальные мемы (картинки, гифки, видео)\n' +
    '- Контент должен быть безопасным для работы (NSFW запрещён)\n' +
    '- Материалы без водяных знаков и рекламы\n\n' +

    '<b>Требования законодательства РФ:</b>\n' +
    '- Запрещены экстремистские, террористические и противоправные материалы\n' +
    '- Не допускается разжигание ненависти, дискриминация и буллинг\n' +
    '- Запрещена пропаганда наркотиков, насилия и суицида\n' +
    '- Нельзя нарушать авторские права (только оригиналы или разрешённый контент)\n\n' +

    '<b>Мы можем изменить предложенный пост:</b>\n' +
    '- Подпись к картинкам или видео будет удалена или отредактирована\n' +
    '- Публикация может быть отклонена, если админу пост покажется неподходящим\n' +
    '- Публикуемые посты будут подписаны автором (если не анонимно)\n' +
    '- Пост может быть опубликован не сразу (очередь модерации)\n\n' +

    '<b>Дополнительные условия:</b>\n' +
    '- Повторяющийся или низкокачественный контент удаляется\n' +
    '- Спам, флуд и фейки запрещены\n' +
    '- Администрация оставляет право баннить за нарушения без предупреждения';


  private buildStartUserMenu(): Menu<BotContext> {
    const menu = new Menu<BotContext>(UserMenusEnum.USER_START_MENU)
      .text('Показать правила', (ctx) => ctx.reply(this.MEME_RULES, { parse_mode: 'HTML' }))
      .row()
      .submenu('Настройки', 'main-settings-menu')
      .row()
      .text('Связаться с админом', async (ctx) => {
        await ctx.reply('Просто напиши сообщение, тебе ответят')
      })
      .row()
      .url('Перейти в канал', 'https://t.me/filipp_memes');

    const settings = new Menu<BotContext>('main-settings-menu')
      .text(
        (ctx) => (ctx.session.canBeModeratePosts ? '👮 Оцениваю посты' : '🙅 Не оцениваю посты'),
        async (ctx) => {
          ctx.session.canBeModeratePosts = !ctx.session.canBeModeratePosts;
          await this.userService.changeUserModeratedMode(
            ctx.from.id,
            ctx.session.canBeModeratePosts
          );
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
    this.moderatorStartMenu = this.moderatorStartMenuService.buildStartModeratorMenu(
      this.userStartMenu
    );
    this.adminStartMenu = this.adminMenuService.buildStartAdminMenu(
      this.userStartMenu,
      this.moderatorStartMenu
    );
    this.bot.use(this.userStartMenu);
    this.bot.use(this.moderatorStartMenu);
    this.bot.use(this.adminStartMenu);
  }
}
