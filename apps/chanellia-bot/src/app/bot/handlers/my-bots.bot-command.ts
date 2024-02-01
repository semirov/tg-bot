import {Inject, Injectable, OnModuleInit} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {ManagedBotService} from '../services/managed-bot.service';
import {Menu, MenuRange} from '@grammyjs/menu';
import {ClientsRepositoryService} from '../services/clients-repository.service';

@Injectable()
export class MyBotsBotCommand implements OnModuleInit {
  constructor(
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>,
    private managedBotService: ManagedBotService,
    private clientsRepositoryService: ClientsRepositoryService
  ) {
  }

  private myBotsMainMenu: Menu;

  public onModuleInit(): void {
    this.prepareMenu();
    this.bot.command('mybots', async (ctx: BotContext) => {
      const adminId = ctx.from.id;
      await this.managedBotService.actualizeBotNamesByAdminId(adminId);

      const botsCount = await this.clientsRepositoryService.botsCountByAdminId(adminId);

      if (!botsCount) {
        return void ctx.reply('Активных ботов нет');
      }

      ctx.reply('Вот список активных ботов', {reply_markup: this.myBotsMainMenu});
    });
  }

  private prepareMenu() {
    const menu = new Menu('mybots_Menu');

    menu.dynamic(async (ctx: BotContext) => {
      const adminId = ctx.from.id;
      const clients = await this.clientsRepositoryService.getClientsByAdminId(adminId);
      const range = new MenuRange();
      for (let i = 0; i < clients.length; i++) {
        const client = clients[i];
        const menuRange = range.text(`@${client.botUsername}`, (ctx) =>
          ctx.reply(`You chose ${i}`)
        );
        if (i + (1 % 2) === 0) {
          menuRange.row();
        }
      }
      return range;
    });

    const botSettingsMenu = new Menu('mybots_botSettingsMenu');

    this.bot.use(menu);
    this.myBotsMainMenu = menu;
  }
}
