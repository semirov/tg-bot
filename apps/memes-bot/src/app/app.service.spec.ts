// BotProvider тянет runner/storage-typeorm/typeorm — для теста достаточно токена.
jest.mock('./modules/bot/providers/bot.provider', () => ({ BOT: 'APP_BOT_TOKEN' }));

// axios — ESM и не парсится jest; метаданные NestJS тянут DeepSeekService транзитивно.
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ post: jest.fn() })) },
  isAxiosError: () => false,
}));

import { InlineKeyboard } from 'grammy';
import { AppService } from './app.service';

type Handler = (ctx: any, next?: any) => any;

function makeCtx(overrides: any = {}): any {
  return {
    chat: { type: 'private' },
    from: { id: 111 },
    session: {},
    reply: jest.fn().mockResolvedValue({ chat: { id: 111 }, message_id: 10 }),
    conversation: { enter: jest.fn() },
    match: undefined,
    ...overrides,
  };
}

describe('AppService', () => {
  let service: AppService;
  let bot: any;
  let mainMenuService: any;
  let baseConfigService: any;
  let userPostManagementService: any;
  let userService: any;
  let settingsService: any;
  let commands: Record<string, Handler>;
  let events: Record<string, Handler>;

  beforeEach(() => {
    commands = {};
    events = {};
    bot = {
      use: jest.fn(),
      command: jest.fn((cmd: string | string[], handler: Handler) => {
        (Array.isArray(cmd) ? cmd : [cmd]).forEach((c) => (commands[c] = handler));
        return bot;
      }),
      on: jest.fn((evt: string | string[], handler: Handler) => {
        (Array.isArray(evt) ? evt : [evt]).forEach((e) => (events[e] = handler));
        return bot;
      }),
      api: {
        getChatMember: jest.fn(),
        getChat: jest.fn(),
        sendMessage: jest.fn().mockResolvedValue({}),
        approveChatJoinRequest: jest.fn().mockResolvedValue(undefined),
        deleteMessage: jest.fn().mockResolvedValue(undefined),
      },
    };
    mainMenuService = {
      initStartMenu: jest.fn(),
      getRoleBasedStartMenu: jest.fn().mockReturnValue({ menu: 'role' }),
    };
    baseConfigService = { memeChanelId: -100500, ownerId: 999, parserUserId: 4242 };
    userPostManagementService = {
      handleUserMemeRequest: jest.fn().mockResolvedValue(undefined),
      handleUserTextRequest: jest.fn().mockResolvedValue(undefined),
    };
    userService = { updateUserLastActivity: jest.fn().mockResolvedValue(undefined) };
    settingsService = {
      channelHtmlLink: jest.fn().mockResolvedValue('<a href="https://t.me/ch">канал</a>'),
      channelLinkUrl: jest.fn().mockResolvedValue('https://t.me/ch'),
    };
    service = new AppService(
      mainMenuService,
      bot,
      baseConfigService,
      userPostManagementService,
      userService,
      settingsService
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('регистрирует беседу капчи, стартовое меню и все обработчики', () => {
      service.onModuleInit();

      expect(bot.use).toHaveBeenCalledTimes(1);
      expect(typeof bot.use.mock.calls[0][0]).toBe('function');
      expect(mainMenuService.initStartMenu).toHaveBeenCalledTimes(1);
      expect(Object.keys(commands).sort()).toEqual(['menu', 'start']);
      expect(Object.keys(events).sort()).toEqual(['chat_join_request', 'message']);
    });
  });

  describe('menu', () => {
    beforeEach(() => service.onModuleInit());

    it('в не-личном чате молча выходит', async () => {
      const ctx = makeCtx({ chat: { type: 'group' } });
      await commands['menu'](ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(userService.updateUserLastActivity).not.toHaveBeenCalled();
    });

    it('устойчив к отсутствующему chat', async () => {
      const ctx = makeCtx({ chat: undefined });
      await commands['menu'](ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('в личке показывает ролевое меню и обновляет активность', async () => {
      const ctx = makeCtx();
      await commands['menu'](ctx);

      expect(mainMenuService.getRoleBasedStartMenu).toHaveBeenCalledWith(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Выбери то, что хочешь сделать', {
        reply_markup: { menu: 'role' },
      });
      expect(userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
    });
  });

  describe('start', () => {
    beforeEach(() => service.onModuleInit());

    it('на payload vertis_tech_party отправляет спец-приветствие с ссылками', async () => {
      const ctx = makeCtx({ match: 'vertis_tech_party' });
      await commands['start'](ctx);

      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const [text, options] = ctx.reply.mock.calls[0];
      expect(text).toContain('Привет с Vertis Tech Party');
      expect(text).toContain('Спасибо что слушал мой доклад');
      expect(options.parse_mode).toBe('HTML');
      expect(options.reply_markup).toBeInstanceOf(InlineKeyboard);

      const keyboard = options.reply_markup.inline_keyboard;
      expect(keyboard).toHaveLength(4);
      expect(keyboard[0][0]).toMatchObject({
        text: 'github',
        url: 'https://github.com/semirov/tg-bot',
      });
      expect(keyboard[1][0].url).toBe('https://t.me/filipp_memes');
      expect(keyboard[2][0].url).toBe('https://t.me/filipp_memes_best');
      expect(keyboard[3][0].text).toBe('Вертикали нанимают 😉');
      expect(userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
    });

    it('без payload отправляет стандартное приветствие со ссылкой на канал', async () => {
      const ctx = makeCtx({ match: '' });
      await commands['start'](ctx);

      const [text, options] = ctx.reply.mock.calls[0];
      expect(settingsService.channelHtmlLink).toHaveBeenCalledTimes(1);
      expect(text).toContain('<a href="https://t.me/ch">канал</a>');
      expect(text).toContain('нажми /menu');
      expect(options).toEqual({ parse_mode: 'HTML' });
      expect(userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
    });

    it('payload другого значения идёт по стандартной ветке', async () => {
      const ctx = makeCtx({ match: 'other_value' });
      await commands['start'](ctx);

      expect(settingsService.channelHtmlLink).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('Привет, это бот канала');
    });
  });

  describe('message', () => {
    beforeEach(() => service.onModuleInit());

    it('в не-личном чате передаёт управление дальше через next', async () => {
      const ctx = makeCtx({ chat: { type: 'channel' } });
      const next = jest.fn();
      await events['message'](ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('устойчив к отсутствующему chat', async () => {
      const ctx = makeCtx({ chat: undefined });
      const next = jest.fn();
      await events['message'](ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('сообщение парсера пропускает без капчи и передаёт дальше', async () => {
      const ctx = makeCtx({ from: { id: 4242 }, session: { captchaSolved: false } });
      const next = jest.fn();
      await events['message'](ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(ctx.conversation.enter).not.toHaveBeenCalled();
      expect(bot.api.getChatMember).not.toHaveBeenCalled();
    });

    it('без PARSER_USER_ID сообщение идёт обычным путём (капча)', async () => {
      baseConfigService.parserUserId = undefined;
      const ctx = makeCtx({ from: { id: 4242 }, session: { captchaSolved: false } });
      await events['message'](ctx, jest.fn());

      expect(ctx.conversation.enter).toHaveBeenCalledWith('privateBotCaptcha');
    });

    it('без решённой капчи запускает капчу и создаёт значения', async () => {
      jest.spyOn(service, 'randomIntFromInterval').mockReturnValueOnce(5).mockReturnValueOnce(3).mockReturnValueOnce(0);
      const ctx = makeCtx({ session: { captchaSolved: false } });
      await events['message'](ctx, jest.fn());

      expect(ctx.conversation.enter).toHaveBeenCalledWith('privateBotCaptcha');
      expect(ctx.session.captchaValues).toEqual({ first: 5, second: 3, operand: '+', result: 8 });
      expect(bot.api.getChatMember).not.toHaveBeenCalled();
    });

    it('с решённой капчей и неподпиской одобряет заявку', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'left' });
      bot.api.getChat.mockResolvedValue({ title: 'Мемный канал' });
      const ctx = makeCtx({ session: { captchaSolved: true } });
      await events['message'](ctx, jest.fn());

      expect(bot.api.getChatMember).toHaveBeenCalledWith(-100500, 111);
      expect(bot.api.approveChatJoinRequest).toHaveBeenCalledWith(-100500, 111);
      expect(userService.updateUserLastActivity).not.toHaveBeenCalled();
    });

    it('если одобрить заявку не удалось — присылает ссылку на подписку', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'kicked' });
      bot.api.approveChatJoinRequest.mockRejectedValue(new Error('forbidden'));
      bot.api.getChat.mockResolvedValue({ title: 'Мемный канал' });
      const ctx = makeCtx({ session: { captchaSolved: true } });
      await events['message'](ctx, jest.fn());

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        111,
        expect.stringContaining('Сначала подпишись'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
    });

    it.each(['member', 'creator', 'administrator'])(
      'подписчик со статусом %s может присылать фото',
      async (status) => {
        bot.api.getChatMember.mockResolvedValue({ status });
        const ctx = makeCtx({
          session: { captchaSolved: true },
          message: { photo: [{ file_id: 'p' }] },
        });
        await events['message'](ctx, jest.fn());

        expect(userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
        expect(userPostManagementService.handleUserMemeRequest).toHaveBeenCalledWith(ctx);
        expect(userPostManagementService.handleUserTextRequest).not.toHaveBeenCalled();
      }
    );

    it('видео тоже уходит в обработку мемов', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const ctx = makeCtx({
        session: { captchaSolved: true },
        message: { video: { file_id: 'v' } },
      });
      await events['message'](ctx, jest.fn());
      expect(userPostManagementService.handleUserMemeRequest).toHaveBeenCalledWith(ctx);
    });

    it('текстовое сообщение уходит в обработку обращений', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const ctx = makeCtx({
        session: { captchaSolved: true },
        message: { text: 'привет админ' },
      });
      await events['message'](ctx, jest.fn());
      expect(userPostManagementService.handleUserTextRequest).toHaveBeenCalledWith(ctx);
    });

    it('сообщение другого типа получает подсказку о форматах', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const ctx = makeCtx({
        session: { captchaSolved: true },
        message: { sticker: { file_id: 's' } },
      });
      await events['message'](ctx, jest.fn());

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('только текстовые сообщения'));
      expect(userPostManagementService.handleUserTextRequest).not.toHaveBeenCalled();
    });
  });

  describe('chat_join_request', () => {
    beforeEach(() => service.onModuleInit());

    it('отправляет заявщику инструкцию по капче', async () => {
      const ctx = { chatJoinRequest: { from: { id: 777 } } } as any;
      await events['chat_join_request'](ctx);

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        777,
        expect.stringContaining('напиши любое сообщение'),
        { parse_mode: 'HTML' }
      );
      const message = bot.api.sendMessage.mock.calls[0][1];
      expect(message).toContain('Реши ее и бот пустит тебя в канал');
    });
  });

  describe('randomIntFromInterval', () => {
    it('на нижней границе возвращает min', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(service.randomIntFromInterval(1, 25)).toBe(1);
    });

    it('около верхней границы возвращает max', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.999999);
      expect(service.randomIntFromInterval(1, 25)).toBe(25);
    });
  });

  describe('prepareCaptchaValues', () => {
    it('сортирует по убыванию и складывает при operandCase=0', () => {
      jest
        .spyOn(service, 'randomIntFromInterval')
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(25)
        .mockReturnValueOnce(0);

      expect(service.prepareCaptchaValues()).toEqual({
        operand: '+',
        result: 26,
        first: 25,
        second: 1,
      });
    });

    it('вычитает большее из меньшего при operandCase=1', () => {
      jest
        .spyOn(service, 'randomIntFromInterval')
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(25)
        .mockReturnValueOnce(1);

      expect(service.prepareCaptchaValues()).toEqual({
        operand: '-',
        result: 24,
        first: 25,
        second: 1,
      });
    });
  });

  describe('sendCaptcha', () => {
    it('создаёт значения, если их нет, и входит в беседу', async () => {
      const ctx = makeCtx({ session: {}, conversation: { enter: jest.fn() } });
      await (service as any).sendCaptcha(ctx);

      const values = ctx.session.captchaValues;
      expect(values.first).toBeGreaterThanOrEqual(values.second);
      expect(values.operand).toMatch(/^[+-]$/);
      const expected =
        values.operand === '+' ? values.first + values.second : values.first - values.second;
      expect(values.result).toBe(expected);
      expect(ctx.conversation.enter).toHaveBeenCalledWith('privateBotCaptcha');
    });

    it('не перезатирает уже сохранённые значения', async () => {
      const existing = { first: 9, second: 4, operand: '-', result: 5 };
      const ctx = makeCtx({ session: { captchaValues: existing } });
      await (service as any).sendCaptcha(ctx);

      expect(ctx.session.captchaValues).toBe(existing);
    });
  });

  describe('approveUserJoin', () => {
    beforeEach(() => {
      bot.api.getChat.mockResolvedValue({ title: 'Мемный канал' });
    });

    it('берёт данные из chatJoinRequest, одобряет и уведомляет владельца', async () => {
      const ctx = {
        chatJoinRequest: {
          from: {
            id: 42,
            first_name: 'Иван',
            last_name: 'Петров',
            username: 'vanya',
            is_bot: false,
            is_premium: true,
          },
        },
      } as any;

      await (service as any).approveUserJoin(ctx);

      expect(bot.api.approveChatJoinRequest).toHaveBeenCalledWith(-100500, 42);
      expect(bot.api.sendMessage.mock.calls[0][0]).toBe(42);
      expect(bot.api.sendMessage.mock.calls[0][1]).toContain('Мемный канал');
      expect(bot.api.sendMessage.mock.calls[1]).toEqual([
        999,
        'Новый подписчик:\n 👑 Иван Петров @vanya',
      ]);
    });

    it('fallback на ctx.from и пропускает пустые поля', async () => {
      const ctx = makeCtx({
        from: {
          id: 55,
          first_name: 'Бот',
          last_name: undefined,
          username: undefined,
          is_bot: true,
          is_premium: false,
        },
      });

      await (service as any).approveUserJoin(ctx);

      expect(bot.api.approveChatJoinRequest).toHaveBeenCalledWith(-100500, 55);
      expect(bot.api.sendMessage.mock.calls[1]).toEqual([999, 'Новый подписчик:\n 🤖 Бот']);
    });

    it('при наличии chatJoinRequest берёт данные заявки, а не ctx.from', async () => {
      const ctx = makeCtx({
        from: { id: 1, first_name: 'НеОн', is_bot: false, is_premium: false },
        chatJoinRequest: {
          from: { id: 88, first_name: 'Заявка', is_bot: false, is_premium: false },
        },
      });

      await (service as any).approveUserJoin(ctx);

      expect(bot.api.approveChatJoinRequest).toHaveBeenCalledWith(-100500, 88);
      expect(bot.api.sendMessage.mock.calls[1]).toEqual([999, 'Новый подписчик:\n Заявка']);
    });
  });

  describe('sendLinkForNonSubscribedUser', () => {
    it('отправляет кнопку подписки на канал', async () => {
      bot.api.getChat.mockResolvedValue({ title: 'Мемный канал' });
      const ctx = makeCtx();

      await service.sendLinkForNonSubscribedUser(ctx);

      expect(bot.api.getChat).toHaveBeenCalledWith(-100500);
      expect(settingsService.channelLinkUrl).toHaveBeenCalledTimes(1);
      const [chatId, text, options] = bot.api.sendMessage.mock.calls[0];
      expect(chatId).toBe(111);
      expect(text).toContain('Мемный канал');
      expect(text).toContain('Сначала подпишись');
      expect(options.parse_mode).toBe('HTML');
      expect(options.reply_markup.inline_keyboard[0][0]).toMatchObject({
        text: 'Подписаться',
        url: 'https://t.me/ch',
      });
    });
  });

  describe('prepareCaptchaConversation', () => {
    function makeConversation(answers: any[], session: any) {
      return {
        session,
        wait: jest.fn(() => Promise.resolve(answers.shift())),
        external: jest.fn((op: any) => Promise.resolve(typeof op === 'function' ? op() : op.task())),
      };
    }

    function answerCtx(text: string): any {
      return {
        message: { text },
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        api: { deleteMessage: jest.fn().mockResolvedValue(undefined) },
      };
    }

    function captchaCtx(overrides: any = {}): any {
      return makeCtx({
        from: { id: 77 },
        message: { text: 'привет' },
        ...overrides,
      });
    }

    it('верный ответ: удаляет сообщения, отмечает капчу и обрабатывает исходный текст', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const answer = answerCtx('8');
      const conversation = makeConversation(
        [answer],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx();

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Чему равно <b>5 + 3?</b>'), {
        parse_mode: 'HTML',
      });
      expect(answer.deleteMessage).toHaveBeenCalledTimes(1);
      expect(answer.api.deleteMessage).toHaveBeenCalledWith(111, 10);
      expect(conversation.session.captchaValues).toBeNull();
      expect(conversation.session.captchaSolved).toBe(true);
      expect(userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
      expect(userPostManagementService.handleUserTextRequest).toHaveBeenCalledWith(ctx);
    });

    it('верный ответ с фото уходит в обработку мемов', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const conversation = makeConversation(
        [answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx({ message: { photo: [{ file_id: 'p' }] } });

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(userPostManagementService.handleUserMemeRequest).toHaveBeenCalledWith(ctx);
    });

    it('верный ответ на команду: присылает сообщение о пройденной капче', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const conversation = makeConversation(
        [answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx({ message: { text: '/menu' } });

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Капча пройдена!'));
      expect(userPostManagementService.handleUserTextRequest).not.toHaveBeenCalled();
    });

    it('верный ответ на прочее сообщение: тоже сообщает о пройденной капче', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const conversation = makeConversation(
        [answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx({ message: { sticker: { file_id: 's' } } });

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Капча пройдена!'));
    });

    it('неверный ответ переспрашивает, затем верный принимает', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const conversation = makeConversation(
        [answerCtx('wrong'), answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx();

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Капчу все таки надо решить'),
        { parse_mode: 'HTML' }
      );
      expect(conversation.session.captchaSolved).toBe(true);
    });

    it('устойчиво к пустому ответу (нет message.text)', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const empty = { message: {}, deleteMessage: jest.fn(), api: { deleteMessage: jest.fn() } };
      const conversation = makeConversation(
        [empty, answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx();

      await (service as any).prepareCaptchaConversation(conversation, ctx);
      expect(conversation.session.captchaSolved).toBe(true);
    });

    it('устойчиво к ответу без message', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const noMessage = {
        message: null,
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        api: { deleteMessage: jest.fn().mockResolvedValue(undefined) },
      };
      const conversation = makeConversation(
        [noMessage, answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx();

      await (service as any).prepareCaptchaConversation(conversation, ctx);
      expect(conversation.session.captchaSolved).toBe(true);
    });

    it('верный ответ с видео уходит в обработку мемов', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'member' });
      const conversation = makeConversation(
        [answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx({ message: { video: { file_id: 'v' } } });

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(userPostManagementService.handleUserMemeRequest).toHaveBeenCalledWith(ctx);
      expect(userPostManagementService.handleUserTextRequest).not.toHaveBeenCalled();
    });

    it('неподписанного после капчи одобряет', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'left' });
      bot.api.getChat.mockResolvedValue({ title: 'Мемный канал' });
      const conversation = makeConversation(
        [answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx();

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(bot.api.approveChatJoinRequest).toHaveBeenCalledWith(-100500, 77);
      expect(userService.updateUserLastActivity).not.toHaveBeenCalled();
    });

    it('если одобрение упало — шлёт ссылку на подписку', async () => {
      bot.api.getChatMember.mockResolvedValue({ status: 'left' });
      bot.api.approveChatJoinRequest.mockRejectedValue(new Error('nope'));
      bot.api.getChat.mockResolvedValue({ title: 'Мемный канал' });
      const conversation = makeConversation(
        [answerCtx('8')],
        { captchaValues: { first: 5, second: 3, operand: '+', result: 8 } }
      );
      const ctx = captchaCtx();

      await (service as any).prepareCaptchaConversation(conversation, ctx);

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        77,
        expect.stringContaining('Сначала подпишись'),
        expect.any(Object)
      );
    });
  });
});
