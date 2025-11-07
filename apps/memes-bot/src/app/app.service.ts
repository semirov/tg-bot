import { Conversation, createConversation } from '@grammyjs/conversations';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Bot, CommandContext, InlineKeyboard } from 'grammy';
import { BotContext, CaptchaValuesInterface } from './modules/bot/interfaces/bot-context.interface';
import { BOT } from './modules/bot/providers/bot.provider';
import { SettingsService } from './modules/bot/services/settings.service';
import { UserService } from './modules/bot/services/user.service';
import { BaseConfigService } from './modules/config/base-config.service';
import { MainMenuService } from './modules/menus/main-menu.service';
import { UserPostManagementService } from './modules/post-management/user-post-management.service';

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
    this.onStartCommand();
    this.onMenuCommand();
    this.onUserMessage();
    this.onNewMember();
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
      // Проверяем, есть ли параметр start с определенным значением
      const startPayload = ctx.match;

      if (startPayload === 'vertis_tech_party') {
        // Специальное приветствие для участников Vertis Tech Party
        const text =
          'Привет с Vertis Tech Party 😏\n\n' +
          'Вот тебе полезные ссылки в одном месте \n\n' +
          'Спасибо что слушал мой доклад ❤️  \n\n' +
          'Если у тебя есть вопросы, то ты можешь задать их в конце доклада или прям в этого бота, я отвечу, правда';

        // Создаем кнопки для ссылок
        const keyboard = new InlineKeyboard()
          .url('github', 'https://github.com/semirov/tg-bot')
          .row()
          .url('Пук и кек', 'https://t.me/filipp_memes')
          .row()
          .url('Два мема в сутки (или один)', 'https://t.me/filipp_memes_best');

        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } else {
        // Стандартное приветствие
        const channelLink = await this.settingsService.channelHtmlLink();
        const text =
          'Привет, это бот канала' +
          ` ${channelLink}\n\n` +
          'Можешь прислать пост\n' +
          'или нажми /menu, чтобы показать основное меню бота.\n\n' +
          'Если у тебя есть вопрос или предложение для администратора, просто напиши сообщение';
        await ctx.reply(text, { parse_mode: 'HTML' });
      }
      await this.userService.updateUserLastActivity(ctx);
    });
  }

  private onUserMessage() {
    this.bot.on(['message'], async (ctx: BotContext) => {
      // Проверка на прохождение капчи
      if (!ctx.session.captchaSolved) {
        return this.sendCaptcha(ctx);
      }

      // Проверка на подписку пользователя к каналу
      const chatMember = await this.bot.api.getChatMember(
        this.baseConfigService.memeChanelId,
        ctx.from.id
      );

      if (!['member', 'creator', 'administrator'].includes(chatMember.status)) {
        try {
          await this.approveUserJoin(ctx);
        } catch (e) {
          await this.sendLinkForNonSubscribedUser(ctx);
        }
        return;
      }

      // Обновляем информацию о последней активности пользователя
      await this.userService.updateUserLastActivity(ctx);

      // Теперь разделяем обработку по типу сообщения
      if (ctx.message.photo || ctx.message.video) {
        // Если это медиаконтент, обрабатываем как запрос на публикацию
        await this.userPostManagementService.handleUserMemeRequest(ctx);
      } else if (ctx.message.text) {
        // Если это текстовое сообщение, обрабатываем как обращение к администрации
        await this.userPostManagementService.handleUserTextRequest(ctx);
      } else {
        // Если сообщение другого типа, сообщаем о поддерживаемых форматах
        await ctx.reply(
          'Я могу обработать только текстовые сообщения, фото или видео. ' +
            'Если у тебя есть вопрос к администратору, просто напиши его текстом. ' +
            'Если хочешь предложить пост в канал, пришли фото или видео.'
        );
      }
    });
  }

  public randomIntFromInterval(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  public prepareCaptchaValues(): CaptchaValuesInterface {
    const values = [this.randomIntFromInterval(1, 25), this.randomIntFromInterval(1, 25)].sort(
      (a, b) => b - a
    );
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
    return { operand, result, first, second };
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
        parse_mode: 'HTML',
      });
      return;
    });
  }

  private async approveUserJoin(ctx: BotContext) {
    const { first_name, last_name, username, is_bot, is_premium, id } = (
      ctx?.chatJoinRequest || ctx
    ).from;
    await this.bot.api.approveChatJoinRequest(this.baseConfigService.memeChanelId, id);
    const channelInfo = await this.bot.api.getChat(this.baseConfigService.memeChanelId);
    const channelUrl = await this.settingsService.channelLinkUrl();
    let messageText = `Привет!\nДобро пожаловать в канал <b>${channelInfo['title']}</b>!`;
    messageText +=
      '\n\nЕсли хочешь, чтобы твой пост опубликовали в канале, просто пришли его в бота.';
    messageText += '\nЧтобы перейти в канал, нажми кнопку ниже';
    messageText += '\nили напиши сообщение прям в бота если есть вопросы или предложения к админу';
    const menu = new InlineKeyboard().url('Перейти в канал', channelUrl);
    await this.bot.api.sendMessage(id, messageText, {
      reply_markup: menu,
      parse_mode: 'HTML',
    });

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

    await this.bot.api.sendMessage(this.baseConfigService.ownerId, text);
  }

  private async prepareCaptchaConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    const { first, second, operand, result } = conversation.session.captchaValues;
    let message = `Это простая проверка на то, бот ты или человек.\n`;
    message += `Пока ты не решишь эту простую задачу, бот не будет тебе отвечать\n\n`;
    message += `Чему равно <b>${first} ${operand} ${second}?</b>\n\n`;
    message += `Ответ пришли одним числом`;
    const captchaMessage = await ctx.reply(message, { parse_mode: 'HTML' });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answerCtx = await conversation.wait();

      if (Number(answerCtx?.message?.text?.trim()) === result) {
        await answerCtx.deleteMessage();
        await answerCtx.api.deleteMessage(captchaMessage.chat.id, captchaMessage.message_id);
        conversation.session.captchaValues = null;
        conversation.session.captchaSolved = true;
        const chatMember = await conversation.external(async () =>
          this.bot.api.getChatMember(this.baseConfigService.memeChanelId, ctx.from.id)
        );

        if (!['member', 'creator', 'administrator'].includes(chatMember.status)) {
          try {
            await conversation.external(async () => this.approveUserJoin(ctx));
          } catch (e) {
            await this.sendLinkForNonSubscribedUser(ctx);
          }
          return;
        }

        await this.userService.updateUserLastActivity(ctx);

        // Обрабатываем исходное сообщение пользователя после прохождения капчи
        if (ctx.message.photo || ctx.message.video) {
          await conversation.external(async () =>
            this.userPostManagementService.handleUserMemeRequest(ctx)
          );
        } else if (ctx.message.text && !ctx.message.text.startsWith('/')) {
          await conversation.external(async () =>
            this.userPostManagementService.handleUserTextRequest(ctx)
          );
        } else {
          // Для команд и других типов сообщений
          await ctx.reply(
            'Капча пройдена! Теперь ты можешь предлагать посты или обращаться к администратору. ' +
              'Нажми /menu для просмотра доступных функций.'
          );
        }
        return;
      }

      await answerCtx.deleteMessage();
      const session = conversation.session;
      const { first, second, operand } = session.captchaValues;
      await ctx.reply(
        `Капчу все таки надо решить\nЧему равно <b>${first} ${operand} ${second}?</b>`,
        { parse_mode: 'HTML' }
      );
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
      parse_mode: 'HTML',
    });
  }
}
