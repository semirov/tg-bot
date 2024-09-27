import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { MainMenuService } from './modules/menus/main-menu.service';
import { BOT } from './modules/bot/providers/bot.provider';
import { Bot, CommandContext, InlineKeyboard } from 'grammy';
import {
  BotContext,
  CaptchaValuesInterface,
  SessionDataInterface
} from './modules/bot/interfaces/bot-context.interface';
import { BaseConfigService } from './modules/config/base-config.service';
import { UserService } from './modules/bot/services/user.service';
import { UserPostManagementService } from './modules/post-management/user-post-management.service';
import { ConversationsEnum } from './modules/post-management/constants/conversations.enum';
import { SettingsService } from './modules/bot/services/settings.service';
import { Conversation, createConversation } from '@grammyjs/conversations';
import { ChatFullInfo } from 'grammy/types';

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
        'Можешь прислать пост\n' +
        'или нажми /menu, чтобы показать основное меню бота\n\n' +
        `Если хочешь, чтобы твой пост опубликовали ${
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

      const chatMember = await  this.bot.api.getChatMember(this.baseConfigService.memeChanelId, ctx.from.id);

      if (chatMember.status !== 'member') {
        try {
          await this.approveUserJoin(ctx);
        } catch (e) {
          await this.sendLinkForNonSubscribedUser(ctx);
        }
        return;
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
    if (!ctx.session.captchaValues) {
      ctx.session.captchaValues = this.prepareCaptchaValues();
    }
    await ctx.conversation.enter('privateBotCaptcha');
  }

  private onNewMember() {
    this.bot.on(['chat_join_request'], async (ctx: BotContext) => {
      let message = `Увы, но я сталкиваюсь с большим числом ботов. Чтобы подтвердить что ты живой человек,`;
      message += ` напиши любое сообщение, после чего бот пришлет тебе очень простую задачу.\n`;
      message += `Реши ее и бот пустит тебя в канал`;
      await this.bot.api.sendMessage(ctx.chatJoinRequest.from.id, message, {
        parse_mode: 'HTML'
      });
      return;
    });
  }

  private async approveUserJoin(ctx: BotContext) {
    const { first_name, last_name, username, is_bot, is_premium, id } = (ctx?.chatJoinRequest || ctx).from;
    await this.bot.api.approveChatJoinRequest(this.baseConfigService.memeChanelId, id);
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelUrl = await this.settingsService.channelLinkUrl();
    let messageText = `Привет!\nДобро пожаловать в канал <b>${channelInfo['title']}</b>!`;
    messageText += '\n\nЕсли хочешь, чтобы твой пост опубликовали в канале, просто пришли его в бота.';
    messageText += '\nЧтобы перейти в канал, нажми кнопку ниже';
    messageText += '\nили напиши сообщение прям в бота если есть вопросы или предложения к админу';
    const menu = new InlineKeyboard().url('Перейти в канал', channelUrl);
    await this.bot.api.sendMessage(id, messageText, {
      reply_markup: menu,
      parse_mode: 'HTML'
    });

    const text = [
      'Новый подписчик:\n',
      is_premium ? '👑' : null,
      is_bot ? '🤖' : null,
      first_name,
      last_name,
      username ? `@${username}` : null
    ]
      .filter((v) => !!v)
      .join(' ');

    await this.bot.api.sendMessage(this.baseConfigService.ownerId, text);
  }

  private async prepareCaptchaConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    const {first, second, operand, result} = conversation.session.captchaValues;
    let message = `Это простая проверка на то, бот ты или человек.\n`;
    message += `Пока ты не решишь эту простую задачу, бот не будет тебе отвечать\n\n`;
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
        const chatMember = await  conversation.external( async () => this.bot.api.getChatMember(this.baseConfigService.memeChanelId, ctx.from.id));

        if (chatMember.status !== 'member') {
          try {
            await conversation.external(async () => this.approveUserJoin(ctx));
          } catch (e) {
            await this.sendLinkForNonSubscribedUser(ctx);
          }
          return;
        }
        await this.userService.updateUserLastActivity(ctx);
        await this.userPostManagementService.handleUserMemeRequest(ctx);
        return;
      }
      await answerCtx.deleteMessage();
      const session = conversation.session;
      const {first, second, operand} = session.captchaValues;
      await ctx.reply(`Капчу все таки надо решить\nЧему равно <b>${first} ${operand} ${second}?</b>`, {parse_mode: 'HTML'});
    }
  }


  public async sendLinkForNonSubscribedUser(ctx: BotContext): Promise<void> {
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelUrl = await this.settingsService.channelLinkUrl();
    let messageText = `Как так вышло что ты еще не подписан на <b>${channelInfo['title']}</b>?`;
    messageText += '\n\nСначала подпишись, потом предлагай посты или пиши админу';
    const menu = new InlineKeyboard().url('Подписаться', channelUrl);
    await this.bot.api.sendMessage(ctx.from.id, messageText, {
      reply_markup: menu,
      parse_mode: 'HTML'
    });
  }
}
