import {Inject, Injectable, Logger} from '@nestjs/common';
import {Bot, InlineKeyboard} from 'grammy';
import {BotContext} from '../interfaces/bot-context.interface';
import {BOT} from '../providers/bot.provider';
import {UserService} from './user.service';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {ChannelsEntity} from '../entities/channels.entity';
import {InlineQueryResultArticle} from '@grammyjs/types/inline';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {MessagesEntity} from '../entities/messages.entity';
import {Menu, MenuRange} from '@grammyjs/menu';
import {PredictionFunService} from './prediction-fun.service';
import {User} from '@grammyjs/types/manage';
import {BaseConfigService} from '../../config/base-config.service';

@Injectable()
export class MainMenuService {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private userService: UserService,
    @InjectRepository(ChannelsEntity)
    private channelsEntity: Repository<ChannelsEntity>,
    @InjectRepository(MessagesEntity)
    private messagesEntity: Repository<MessagesEntity>,
    private predictionFunService: PredictionFunService,
    private baseConfigService: BaseConfigService
  ) {
  }

  private answerMenu: Menu<BotContext>;
  private publishAnswerMenu: Menu<BotContext>;

  public init() {
    this.onInlineQueryMessage();
    this.buildPublishAnswerMenu();
    this.bot.use(
      createConversation(this.createMassMessageConversation.bind(this), 'createMessageSendCv')
    );
    this.bot.use(
      createConversation(this.answerQuestionConversation.bind(this), 'answer_conversation')
    );
    this.buildAnswerMenu();
    this.bot.use(createConversation(this.askQuestionConversation.bind(this), 'askCV'));
    this.bot.use(
      createConversation(this.createAnonymousPostConversation.bind(this), 'createAskBtnCv')
    );
    this.predictionFunService.init();
    this.buildMainMenu();
    this.onStartHandler();
  }

  public buildMainMenu(): void {
    const mainMenu = new Menu<BotContext>('menu_main')
      .text('Как разместить анонимный вопрос', (ctx) => this.replyHowToMessage(ctx))
      .row()
      .text('Создать кнопку анонимного вопроса', (ctx) => ctx.conversation.enter('createAskBtnCv'))
      .row()
      .text('Добавить предсказание', (ctx) => ctx.conversation.enter('addPredictionCv'))
      .row()
      .text('Получить предсказание', async (ctx) =>
        this.generatePrediction(ctx.callbackQuery.from, ctx)
      )
      .row()
      .text('Задать вопрос админу', async (ctx) => {
        ctx.session.sendMessageToId = this.baseConfigService.ownerId;
        await ctx.conversation.enter('askCV');
      });

    this.bot.use(mainMenu);

    this.bot.command(['prediction'], async (ctx) => this.generatePrediction(ctx.message.from, ctx));

    this.bot.command(['menu'], async (ctx) => {
      await ctx.reply('Основное меню', {reply_markup: mainMenu});
    });

    this.bot.command(['spam'], async (ctx) => {
      if (!ctx.config.isOwner) {
        return;
      }
      await ctx.conversation.enter('createMessageSendCv');
    });
  }

  private async generatePrediction(user: User, ctx: BotContext): Promise<void> {
    let name;
    if (user.username) {
      name = `@${user.username}`;
    } else {
      name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    }

    const prediction = await this.predictionFunService.getPredictionForUserId(user.id);

    const text = `Предсказание для ${name}\n\n<i>${prediction}</i>`;

    await ctx.reply(text, {parse_mode: 'HTML'});
  }

  private onStartHandler() {
    this.bot.on(['my_chat_member'], async (ctx) => {
      const {chat, from} = ctx.myChatMember;
      await this.channelsEntity.upsert({id: chat.id, type: chat.type, mainOwner: from.id}, [
        'id',
      ]);
    });

    this.bot.command(['how_to'], (ctx) => this.replyHowToMessage(ctx));

    this.bot.command(['start'], async (ctx) => {
      const [, /**/ userId] = ctx.message.text.split(' ');
      ctx.session.sendMessageToId = +userId;
      if (!userId) {
        const bot = await this.bot.api.getMe();
        const link = `https://t.me/${bot.username}?start=${this.baseConfigService.ownerId}`;
        const menu = new InlineKeyboard().url('Задать вопрос админу', link);

        const text =
          'Привет, я вопросный бот\n\n' +
          '- Как разместить анонимный вопрос\n/how_to\n\n' +
          '- Получить предсказание\n/prediction\n\n' +
          '- Основное меню\n/menu\n\n';
        await ctx.reply(text, {reply_markup: menu});
      } else {
        await ctx.conversation.enter('askCV');
      }

      await this.userService.updateUserLastActivity(ctx);
    });
  }

  private buildAnswerMenu(): void {
    this.answerMenu = new Menu<BotContext>('answer_menu')
      .text('Ответить на вопрос', async (ctx) => {
        await ctx.conversation.enter('answer_conversation');
      })
      .row();
    this.bot.use(this.answerMenu);
  }

  private buildPublishAnswerMenu(): void {
    this.publishAnswerMenu = new Menu<BotContext>('publish-answer-menu')
      .text('Опубликовать в канал', async (ctx) => {
        ctx.menu.nav('publish-channels-menu');
      })
      .row();

    const channelListMenu = new Menu<BotContext>('publish-channels-menu').dynamic(async (ctx) => {
      const channels = await this.channelsEntity.find({
        where: {
          mainOwner: ctx.callbackQuery.from.id,
          type: 'channel',
        },
      });
      const range = new MenuRange<BotContext>();
      for (const channel of channels) {
        const channelInfo = await ctx.api.getChat(channel.id);
        range
          .text(channelInfo['title'], async (ctx) => {
            const bot = await this.bot.api.getMe();
            const link = `https://t.me/${bot.username}?start=${ctx.callbackQuery.from.id}`;
            const menu = new InlineKeyboard().url('Задать анонимный вопрос', link);
            await ctx.api.copyMessage(
              channel.id,
              ctx.callbackQuery.from.id,
              ctx.callbackQuery.message.message_id,
              {reply_markup: menu}
            );
            await ctx.deleteMessage();
          })
          .row();
      }
      if (!channels.length) {
        range.text('Список пуст', (ctx) => ctx.deleteMessage());
      }
      return range;
    });
    this.publishAnswerMenu.register(channelListMenu);

    this.bot.use(this.publishAnswerMenu);
  }

  private async replyHowToMessage(ctx: BotContext): Promise<void> {
    const bot = await this.bot.api.getMe();
    const text =
      `👉 Добавь бота в канал\n\n` +
      'Вариант 1.\n\nНажми на название бота\n' +
      'Нажми на кнопку "Добавить в группу или канал"\n' +
      'Выбери свой канал, куда хочешь добавить бота\n' +
      'Выдай разрешение на публикацию, редактирование и удаление сообщений\n\n' +
      'Вариант 2.\n' +
      'Перейди в канал в который хочешь добавить бота\n' +
      'Администраторы -> Добавить администратора\n' +
      `Найди в списке @${bot.username}\n` +
      `Выдай разрешение на публикацию, редактирование и удаление сообщений\n\n` +
      `Призови в сообщении бота @${bot.username} - через пробел можешь указать текст сообщения\n` +
      'Нажми на всплывающую кнопку и бот разместит сообщение со сбором анонимных вопросов\n\n' +
      `👉 Создай кнопку через бота\n\n` +
      'Нажми меню /menu выбери пункт "Создать кнопку анонимного вопроса"' +
      '\nНапиши текст вопроса, бот создаст кнопку, ты можешь переслать куда нужно';
    await ctx.reply(text);
  }

  private async answerInlineQuery(ctx: BotContext): Promise<InlineQueryResultArticle> {
    const bot = await this.bot.api.getMe();
    const link = `https://t.me/${bot.username}?start=${ctx.inlineQuery.from.id}`;
    const menu = new InlineKeyboard().url('Анонимный вопрос', link);

    return {
      id: 'anonymous_query',
      type: 'article',
      title: 'Анонимный вопрос',
      reply_markup: menu,
      description: ctx.inlineQuery.query,
      input_message_content: {
        message_text: ctx.inlineQuery.query || 'Задай вопрос анонимно',
      },
    };
  }

  private async onInlineQueryMessage() {
    this.bot.on(['inline_query'], async (ctx) => {
      try {
        const queryResult: InlineQueryResultArticle[] = [
          await this.predictionFunService.answerPredictionInlineQuery(ctx),
          await this.answerInlineQuery(ctx),
        ];
        await ctx.answerInlineQuery(queryResult, {cache_time: 0});
      } catch (e) {
        Logger.error(e.message, e);
      }
    });
  }

  private async askQuestionConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply(
      'Напиши свой вопрос, он будет задан анонимно. Когда на него ответят, бот пришлет тебе ответ\n' +
      'Если передумал задавать вопрос, нажми /cancel'
    );

    let replyCtx: BotContext = null;
    while (!replyCtx?.message?.text) {
      replyCtx = await conversation.wait();
      if (replyCtx?.message?.text === '/cancel') {
        await ctx.reply(
          'Окей, вопрос не будет отправлен, можешь нажать /menu чтобы показать основное меню бота'
        );
        replyCtx = null;
        return;
      }
      if (replyCtx?.message?.text?.includes('/')) {
        await ctx.reply(
          'Перед тем как задавать новый вопрос, напиши предыдущий, если передумал задавать вопрос, нажми /cancel'
        );
        replyCtx = null;
      } else if (!replyCtx?.message?.text) {
        await ctx.reply(
          'Вопрос может содержать только текст, если передумал задавать вопрос, нажми /cancel'
        );
        replyCtx = null;
      }
    }

    await ctx.reply('Спасибо, твой вопрос будет передан анонимно!');

    const from = ctx?.message?.from || ctx?.callbackQuery?.from;

    await conversation.external(async () => {
      await ctx.api.sendMessage(ctx.session.sendMessageToId, `Новое анонимное сообщение:`);
      const messageInUser = await ctx.api.copyMessage(
        ctx.session.sendMessageToId,
        from.id,
        replyCtx.message.message_id,
        {reply_markup: this.answerMenu}
      );
      await this.messagesEntity.insert({
        anonymousOriginalMessageId: replyCtx.message.message_id,
        anonymousMessageForUerId: ctx.session.sendMessageToId,
        anonymousMessageFromUserId: from.id,
        anonymousMessageCopyId: messageInUser.message_id,
        questionText: replyCtx.message.text,
      });
    });
  }

  private async answerQuestionConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply(
      'Напиши ответ на вопрос, он будет передан тому кто его задал, если передумал отвечать, нажми\n/cancel'
    );

    let replyCtx: BotContext = null;
    while (!replyCtx?.message?.text) {
      replyCtx = await conversation.wait();
      if (replyCtx?.message?.text === '/cancel') {
        await ctx.reply('Окей, не будем отвечать на вопрос');
        replyCtx = null;
        return;
      }
      if (replyCtx?.message?.text?.includes('/')) {
        await ctx.reply(
          'Перед тем как задавать новый вопрос, ответь на предыдущий вопрос, если передумал отвечать, нажми\n/cancel'
        );
        replyCtx = null;
      } else if (!replyCtx?.message?.text) {
        await ctx.reply(
          'Ответ может содержать только текст, если передумал отвечать на вопрос, нажми\n/cancel'
        );
        replyCtx = null;
      }
    }

    await ctx.reply('Спасибо, твой ответ будет передан!');

    await conversation.external(async () => {
      const message = await this.messagesEntity.findOne({
        where: {
          anonymousMessageCopyId: ctx.callbackQuery.message.message_id,
        },
      });
      await ctx.api.editMessageReplyMarkup(
        ctx.callbackQuery.from.id,
        ctx.callbackQuery.message.message_id,
        {reply_markup: null}
      );

      await ctx.api.sendMessage(message.anonymousMessageFromUserId, 'Ответ на вопрос:');
      await ctx.api.forwardMessage(
        message.anonymousMessageFromUserId,
        message.anonymousMessageFromUserId,
        message.anonymousOriginalMessageId
      );
      await ctx.api.copyMessage(
        message.anonymousMessageFromUserId,
        replyCtx.message.from.id,
        replyCtx.message.message_id
      );

      await this.messagesEntity.update(
        {
          anonymousOriginalMessageId: message.anonymousOriginalMessageId,
        },
        {answerMessageId: replyCtx.message.message_id, answerText: replyCtx.message.text}
      );

      const channelCount = await this.channelsEntity.count({
        where: {
          mainOwner: ctx.callbackQuery.from.id,
          type: 'channel',
        },
      });

      const bot = await this.bot.api.getMe();
      const link = `https://t.me/${bot.username}?start=${ctx.callbackQuery.from.id}`;
      const menu = new InlineKeyboard().url('Задать анонимный вопрос', link);

      let text = `<b>Анонимный вопрос:</b>\n`;
      text += message.questionText;
      text += '\n\n';
      text += '<b>Ответ:</b>\n';
      text += replyCtx.message.text;
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: channelCount ? this.publishAnswerMenu : menu,
      });
    });
  }

  private async createAnonymousPostConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply(
      'Напиши текст который будет в сообщении с кнопкой анонимного вопроса.\nЯ создам сообщение с кнопкой, ' +
      'через которую можно будет задать анонимный вопрос, который будет адресован тебе. ' +
      'Ты можешь переслать это сообщение куда захочешь.' +
      '\n\nЕсли хочешь текст по умолчанию, нажми /default' +
      '\n\nЕсли передумал нажми /cancel'
    );

    const bot = await this.bot.api.getMe();
    const link = `https://t.me/${bot.username}?start=${ctx.callbackQuery.from.id}`;
    const menu = new InlineKeyboard().url('Задать анонимный вопрос', link);

    let replyCtx: BotContext = null;
    while (!replyCtx?.message?.text) {
      replyCtx = await conversation.wait();
      if (replyCtx?.message?.text === '/cancel') {
        await ctx.reply('Окей, не будем создавать');
        replyCtx = null;
        return;
      }
      if (replyCtx?.message?.text?.includes('/default')) {
        await ctx.reply('Задай мне анонимный вопрос', {reply_markup: menu});
        return;
      }
      if (replyCtx?.message?.text?.includes('/')) {
        await ctx.reply(
          'Перед тем как задавать новый вопрос, закончи создавать кнопку или нажми\n/cancel'
        );
        replyCtx = null;
      } else if (!replyCtx?.message?.text) {
        await ctx.reply(
          'Сообщение может содержать только текст, если передумал отвечать на вопрос, нажми\n/cancel'
        );
        replyCtx = null;
      }
    }

    await ctx.reply(replyCtx.message.text, {reply_markup: menu});
  }

  private async createMassMessageConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    await ctx.reply(
      'Напиши сообщение для рассылки через бота' + '\n\nЕсли передумал нажми /cancel'
    );

    let replyCtx: BotContext = null;
    while (!replyCtx?.message?.text) {
      replyCtx = await conversation.wait();
      if (replyCtx?.message?.text === '/cancel') {
        await ctx.reply('Окей, не будем ничего слать');
        replyCtx = null;
        return;
      }
      if (!replyCtx?.message?.text) {
        await ctx.reply(
          'Сообщение может содержать только текст, если передумал отвечать на вопрос, нажми\n/cancel'
        );
        replyCtx = null;
      }
    }

    await conversation.external(async () => {
      const users = await this.userService.getUsers();

      await ctx.reply('Сообщение будет отправлено пользователям: ' + users.length);

      for (const user of users) {
        try {
          await ctx.api.copyMessage(user.id, replyCtx.message.from.id, replyCtx.message.message_id);
        } catch (e) {
          await this.userService.disableSendMessageForUser(user.id);
        }
      }
    });
  }
}
