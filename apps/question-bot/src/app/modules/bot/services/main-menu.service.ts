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

@Injectable()
export class MainMenuService {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private userService: UserService,
    @InjectRepository(ChannelsEntity)
    private channelsEntity: Repository<ChannelsEntity>,
    @InjectRepository(MessagesEntity)
    private messagesEntity: Repository<MessagesEntity>
  ) {
  }

  private answerMenu: Menu<BotContext>;
  private publishAnswerMenu: Menu<BotContext>;

  public init() {
    this.onInlineQueryMessage();
    this.buildPublishAnswerMenu();
    this.bot.use(
      createConversation(this.answerQuestionConversation.bind(this), 'answer_conversation')
    );
    this.buildAnswerMenu();
    this.bot.use(createConversation(this.askQuestionConversation.bind(this), 'askCV'));
    this.buildMainMenu();
    this.onStartCommand();
    this.onChatMember();
    this.onStartHandler();
  }

  private onStartCommand() {
    this.bot.command(['how_to'], (ctx) => this.replyHowToMessage(ctx));
  }

  private onChatMember(): void {
    this.bot.on(['my_chat_member'], async (ctx) => {
      const {chat, from} = ctx.myChatMember;
      await this.channelsEntity.upsert({id: chat.id, type: chat.type, mainOwner: from.id}, [
        'id',
      ]);
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
            await ctx.api.copyMessage(
              channel.id,
              ctx.callbackQuery.from.id,
              ctx.callbackQuery.message.message_id
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

  private buildMainMenu(): void {
    const mainMenu = new Menu<BotContext>('menu_main')
      .text('Как разместить анонимный вопрос', (ctx) => this.replyHowToMessage(ctx))
      .row();

    this.bot.use(mainMenu);

    this.bot.command(['menu'], async (ctx) => {
      await ctx.reply('Основное меню', {reply_markup: mainMenu});
    });
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
      `👉 Призови в сообщении бота @${bot.username} - через пробел можешь указать текст сообщения\n` +
      'Нажми на всплывающую кнопку и бот разместит сообщение со сбором анонимных вопросов';
    await ctx.reply(text);
  }

  private onInlineQueryMessage() {
    this.bot.on(['inline_query'], async (ctx) => {
      try {
        const bot = await this.bot.api.getMe();
        const link = `https://t.me/${bot.username}?start=${ctx.inlineQuery.from.id}`;
        const menu = new InlineKeyboard().url('Задать вопрос', link);
        const queryResult: InlineQueryResultArticle[] = [
          {
            id: 'anonymous_query',
            type: 'article',
            title: 'Анонимный вопрос',
            reply_markup: menu,
            description: ctx.inlineQuery.query,
            input_message_content: {
              message_text: ctx.inlineQuery.query || 'Задай вопрос анонимно',
            },
          },
        ];
        await ctx.answerInlineQuery(queryResult);
      } catch (e) {
        Logger.error(e.message, e);
      }
    });
  }

  private onStartHandler() {
    this.bot.command(['start'], async (ctx) => {
      const [, /**/ userId] = ctx.message.text.split(' ');
      ctx.session.sendMessageToId = +userId;
      if (!userId) {
        const text =
          'Привет, с моей помощью можно размещать сбор анонимных вопросов в каналах и где угодно\n\n' +
          '- Как разместить анонимный вопрос\n/how_to\n\n' +
          '- Основное меню\n/menu\n\n' +
          'По всем вопросам: @semirov';
        await ctx.reply(text);
      } else {
        await ctx.conversation.enter('askCV');
      }

      await this.userService.updateUserLastActivity(ctx);
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
      if (replyCtx?.message?.text?.includes('/start')) {
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

    await conversation.external(async () => {
      await ctx.api.sendMessage(ctx.session.sendMessageToId, `Новое анонимное сообщение:`);
      const messageInUser = await ctx.api.copyMessage(
        ctx.session.sendMessageToId,
        ctx.message.from.id,
        replyCtx.message.message_id,
        {reply_markup: this.answerMenu}
      );
      await this.messagesEntity.insert({
        anonymousOriginalMessageId: replyCtx.message.message_id,
        anonymousMessageForUerId: ctx.session.sendMessageToId,
        anonymousMessageFromUserId: replyCtx.message.from.id,
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
      if (replyCtx?.message?.text?.includes('/start')) {
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

      let text = `<b>Анонимный вопрос:</b>\n`;
      text += message.questionText;
      text += '\n\n';
      text += '<b>Ответ:</b>\n';
      text += replyCtx.message.text;
      text += `\n\n<a href="https://t.me/${bot.username}">${bot.first_name}</a>`;
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: channelCount ? this.publishAnswerMenu : null,
      });
    });
  }
}
