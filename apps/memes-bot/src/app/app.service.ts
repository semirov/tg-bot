import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { MainMenuService } from './modules/menus/main-menu.service';
import { BOT } from './modules/bot/providers/bot.provider';
import { Bot, CommandContext, InlineKeyboard } from 'grammy';
import { BotContext, CaptchaValuesInterface } from './modules/bot/interfaces/bot-context.interface';
import { BaseConfigService } from './modules/config/base-config.service';
import { UserService } from './modules/bot/services/user.service';
import { UserPostManagementService } from './modules/post-management/user-post-management.service';
import { ConversationsEnum } from './modules/post-management/constants/conversations.enum';
import { SettingsService } from './modules/bot/services/settings.service';
import { Conversation, createConversation } from '@grammyjs/conversations';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    private mainMenuService: MainMenuService,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService,
    private userPostManagementService: UserPostManagementService,
    private userService: UserService,
    private settingsService: SettingsService
  ) {}

  public onModuleInit(): void {
    this.bot.use(
      createConversation(this.prepareCaptchaConversation.bind(this), 'privateBotCaptcha')
    );
    this.mainMenuService.initStartMenu();
    this.onAskAdmin();
    this.onStartCommand();
    this.onMenuCommand();
    this.onUserMessage();
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
      await ctx.reply(text, { parse_mode: 'HTML' });
      await this.userService.updateUserLastActivity(ctx);
    });
  }

  private onUserMessage() {
    this.bot.on(['message'], async (ctx: BotContext) => {
      if (!ctx.session.captchaSolved) {
        return this.sendCaptcha(ctx);
      }
      await this.userService.updateUserLastActivity(ctx);
      await this.userPostManagementService.handleUserMemeRequest(ctx);
    });
  }

  public randomIntFromInterval(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min)
  }

  public prepareCaptchaValues(): CaptchaValuesInterface {
    const values = [
      this.randomIntFromInterval(1, 25),
      this.randomIntFromInterval(1, 25),
    ].sort((a, b) => b - a);
    const [first, second] = values;

    const operandCase = this.randomIntFromInterval(0, 1);
    let operand = '-';
    let result = 0;
    switch (operandCase) {
      case 0:
        result = first + second;
        operand = '+';
        break;
      case 1:
        result = first - second;
        operand = '-';
        break;
    }
    return {operand, result, first, second};
  }


  private async sendCaptcha(ctx: BotContext): Promise<void> {
    ctx.session.captchaValues = this.prepareCaptchaValues();
    await ctx.conversation.enter('privateBotCaptcha');
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
      const { first_name, last_name, username, is_bot, is_premium } = ctx.chatJoinRequest.from;

      const text = [
        'Новый подписчик:\n',
        is_premium ? '👑' : null,
        is_bot ? '🤖' : null,
        first_name,
        last_name,
        username ? `@${username}` : null,
      ]
        .filter((v) => !!v)
        .join(' ');

      await ctx.approveChatJoinRequest(ctx.chatJoinRequest.from.id);
      await this.bot.api.sendMessage(this.baseConfigService.ownerId, text);
    });
  }

  private async prepareCaptchaConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    const {first, second, operand, result} = conversation.session.captchaValues;
    let message = `Для того чтобы сообщение было доставлено, нужно решить задачу.\n`;
    message += `Пока ты не решишь, бот не будет отвечать\n\n`;
    message += `Чему равно <b>${first} ${operand} ${second}?</b>\n\n`;
    message += `Ответ пришли одним числом`;
    const captchaMessage = await ctx.reply(message, {parse_mode: 'HTML'});

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answerCtx = await conversation.wait();

      if (Number(answerCtx?.message?.text?.trim()) === result) {
        await answerCtx.deleteMessage();
        await answerCtx.api.deleteMessage(captchaMessage.chat.id, captchaMessage.message_id);
        conversation.session.captchaValues = null;
        conversation.session.captchaSolved = true;
        await this.userService.updateUserLastActivity(ctx);
        await this.userPostManagementService.handleUserMemeRequest(ctx);
        return;
      }
      await answerCtx.deleteMessage();
    }
  }
}
