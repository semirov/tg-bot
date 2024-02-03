import {Inject, Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {Bot} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {CHANELLIA_BOT_INSTANCE} from '../providers/bot.provider';
import {ManagedBotService} from '../services/managed-bot.service';
import {Menu, MenuRange} from '@grammyjs/menu';
import {BotsRepositoryService} from '../services/bots-repository.service';

@Injectable()
export class MyBotsBotCommand {
  constructor(
    @Inject(CHANELLIA_BOT_INSTANCE) private bot: Bot<BotContext>,
    private managedBotService: ManagedBotService,
    private clientsRepositoryService: BotsRepositoryService
  ) {
  }

  private myBotsMainMenu: Menu;

  public init(): void {
    this.prepareMenu();
    this.bot.command('mybots', async (ctx: BotContext) => {
      const adminId = ctx.from.id;
      await this.managedBotService.actualizeBotNamesByAdminId(adminId);

      const botsCount = await this.clientsRepositoryService.botsCountByAdminId(adminId);

      if (!botsCount) {
        return void ctx.reply('Активных ботов нет');
      }

      ctx.reply('Список активных ботов', {reply_markup: this.myBotsMainMenu});
    });
  }

  private prepareMenu() {
    const menu = new Menu<BotContext>('mybots_Menu');

    menu.dynamic(async (ctx) => {
      const adminId = ctx.from.id;
      const clients = await this.clientsRepositoryService.getClientsByAdminId(adminId);
      const range = new MenuRange<BotContext>();
      for (let i = 0; i < clients.length; i++) {
        const client = clients[i];
        const menuRange = range.submenu(
          `@${client.botUsername}`,
          'mybots_botSettingsMenu',
          async (ctx) => {
            await ctx.editMessageText(`Бот @${client.botUsername}`);
            ctx.session.currentBot = client;
          }
        );

        if (i + (1 % 2) === 0) {
          menuRange.row();
        }
      }
      return range;
    });

    const botSettingsMenu = new Menu<BotContext>('mybots_botSettingsMenu')
      .submenu('Удалить', 'mybots_deleteBotConfirm', async (ctx) => {
        const client = ctx.session.currentBot;
        await ctx.editMessageText(
          `<b>Точно удалить бота @${client.botUsername}</b>?\nСразу после удаления он перестанет выполнять свои функции`,
          {parse_mode: 'HTML'}
        );
      })
      .row()
      .back('Назад', async (ctx) => {
        ctx.session.currentBot = null;
        await ctx.editMessageText('Список активных ботов');
      });

    const deleteBotConfirmation = new Menu<BotContext>('mybots_deleteBotConfirm')
      .text('Да, удалить', async (ctx) => {
        const client = ctx.session.currentBot;
        await this.clientsRepositoryService.deleteClient(client.id);
        await this.managedBotService.stopBot(client.botId);
        Logger.debug(`Stopping bot @${client.botUsername} (${client.botId})`, MyBotsBotCommand.name)
        await ctx.editMessageText(`Бот @${client.botUsername} остановлен и удален`);
        ctx.session.currentBot = null;
        ctx.menu.close();
      })
      .row()
      .back('Назад', async (ctx) => {
        ctx.session.currentBot = null;
        await ctx.editMessageText('Список активных ботов');
      });

    menu.register(botSettingsMenu, 'mybots_Menu');
    menu.register(deleteBotConfirmation, 'mybots_Menu');
    this.bot.use(menu);
    this.myBotsMainMenu = menu;
  }
}
