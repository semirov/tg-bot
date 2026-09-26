import 'reflect-metadata';

// axios в этом репозитории — ESM, а jest его не транспилирует; реальный клиент
// тестам не нужен, достаточно заглушки, чтобы цепочка импортов не падала.
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

import { Logger } from '@nestjs/common';
import { Menu } from '@grammyjs/menu';
import { UserPostManagementService } from './user-post-management.service';
import { PublicationModesEnum } from './constants/publication-modes.enum';
import { PostModerationMenusEnum } from './constants/post-moderation-menus.enum';
import { UserPermissionEnum } from '../bot/constants/user-permission.enum';

const REQUEST_CHANNEL = -1001;
const MEME_CHANNEL = -1002;

const PHOTO = [
  { file_unique_id: 'small', file_id: 's', width: 1, height: 1 },
  { file_unique_id: 'big', file_id: 'b', width: 2, height: 2 },
];

function makeCtx(over: any = {}): any {
  const ctx: any = {
    me: { id: 999 },
    message: {
      from: {
        id: 42,
        first_name: 'Иван',
        last_name: 'Петров',
        username: 'ivan',
        is_bot: false,
        is_premium: false,
      },
      chat: { id: 42 },
      message_id: 10,
    },
    callbackQuery: {
      from: { id: 7, username: 'mod' },
      message: { message_id: 100, chat: { id: REQUEST_CHANNEL }, text: 'post' },
    },
    update: { callback_query: { message: { message_id: 100 } } },
    session: {},
    config: { user: { id: 7 } },
    match: ['admin_lift_limit_42', '42'],
    react: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue({ message_id: 11 }),
    answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    editMessageText: jest.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    unpinChatMessage: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    menu: { nav: jest.fn(), back: jest.fn() },
  };
  ctx.api = {
    sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
    forwardMessage: jest.fn().mockResolvedValue({ message_id: 2 }),
    copyMessage: jest.fn().mockResolvedValue({ message_id: 3 }),
    pinChatMessage: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    getFile: jest.fn().mockResolvedValue({ file_path: 'p/f.jpg' }),
  };
  return Object.assign(ctx, over);
}

function createHarness() {
  const userRequestRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 77 }] }),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
  };
  const userRepo: any = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 42, username: 'ivan', memeLimitDisabledUntil: null, strikes: 0 }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const userRequestService: any = {
    repository: userRequestRepo,
    countUserMemeRequestsLast24h: jest.fn().mockResolvedValue(0),
    userPostDiscardStatistic: jest.fn().mockResolvedValue({ total: 1, week: 0 }),
    userPostApprovedStatistic: jest.fn().mockResolvedValue({ total: 2, day: 1 }),
    lastPublishedPostTimeAgo: jest.fn().mockResolvedValue('2 дня назад'),
    username: jest.fn().mockResolvedValue('user'),
  };
  const userService: any = {
    repository: userRepo,
    checkPermission: jest.fn().mockReturnValue(true),
    disableMemeLimitForUser: jest.fn().mockResolvedValue(undefined),
    updateUserLastActivity: jest.fn().mockResolvedValue(undefined),
  };
  const postSchedulerService: any = {
    getAllScheduledPosts: jest.fn().mockResolvedValue([]),
    getScheduledPostById: jest.fn().mockResolvedValue(null),
    addPostToSchedule: jest.fn().mockResolvedValue(new Date('2026-01-01T10:00:00Z')),
    findByRequestMessageId: jest.fn().mockResolvedValue(null),
    removeByRequestMessageId: jest.fn().mockResolvedValue(1),
  };
  const settingsService: any = {
    channelBestLinkUrl: jest.fn().mockResolvedValue('https://best'),
    channelBestChannelName: jest.fn().mockResolvedValue('Best'),
    cringeChannelHtmlLink: jest.fn().mockResolvedValue('<a href="c">cringe</a>'),
    channelLinkUrl: jest.fn().mockResolvedValue('https://chan'),
  };
  const cringeManagementService: any = {
    repository: {
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
  };
  const deduplicationService: any = {
    getPostImageHash: jest.fn().mockResolvedValue(null),
    checkDuplicate: jest.fn().mockResolvedValue([]),
    calculateHashDistance: jest.fn().mockReturnValue(0),
    createPublishedPostHash: jest.fn().mockResolvedValue(undefined),
  };
  const clientBaseService: any = { bestMemesDaily$: { subscribe: jest.fn() } };
  const mattermostService: any = { sendPostWithFile: jest.fn().mockResolvedValue(undefined) };
  const trollService: any = { maybeRepostMeme: jest.fn().mockResolvedValue(undefined) };
  const baseConfigService: any = {
    userRequestMemeChannel: REQUEST_CHANNEL,
    memeChanelId: MEME_CHANNEL,
    botToken: 'TOKEN',
    tgEnv: 'prod',
  };
  const bot: any = {
    use: jest.fn(),
    filter: jest.fn(),
    callbackQuery: jest.fn(),
    errorBoundary: jest.fn(),
    api: {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      forwardMessage: jest.fn().mockResolvedValue({ message_id: 2 }),
      copyMessage: jest.fn().mockResolvedValue({ message_id: 3 }),
      pinChatMessage: jest.fn().mockResolvedValue(undefined),
      getChat: jest.fn().mockResolvedValue({ id: MEME_CHANNEL }),
      setMessageReaction: jest.fn().mockResolvedValue(undefined),
      unpinChatMessage: jest.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
      getFile: jest.fn().mockResolvedValue({ file_path: 'p/f.jpg' }),
    },
  };
  const service = new UserPostManagementService(
    bot,
    baseConfigService,
    userService,
    userRequestService,
    postSchedulerService,
    settingsService,
    cringeManagementService,
    deduplicationService,
    clientBaseService,
    mattermostService,
    trollService
  );
  return {
    service,
    bot,
    baseConfigService,
    userService,
    userRequestService,
    userRequestRepo,
    userRepo,
    postSchedulerService,
    settingsService,
    cringeManagementService,
    deduplicationService,
    clientBaseService,
    mattermostService,
    trollService,
  };
}

/** Перехватывает колбэки, переданные в Menu.text, чтобы дёргать их вручную. */
function captureHandlers(build: () => void): any[][] {
  const spy = jest.spyOn(Menu.prototype as any, 'text');
  spy.mockClear();
  build();
  const calls = spy.mock.calls.map((c) => c as any[]);
  spy.mockRestore();
  return calls;
}

function byLabel(calls: any[][], label: string): any {
  const call = calls.find((c) => c[0] === label);
  if (!call) throw new Error(`menu item not found: ${label}`);
  return call[1];
}

function publishContext(mode: PublicationModesEnum, over: any = {}): any {
  return {
    mode,
    requestChannelMessageId: 100,
    processedByModerator: 7,
    isUserPost: true,
    hash: 'hash',
    ...over,
  };
}

describe('UserPostManagementService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    function initHarness() {
      const h = createHarness();
      const composer = { on: jest.fn() };
      h.bot.filter.mockReturnValue(composer);
      h.service.onModuleInit();
      return { ...h, composer };
    }

    it('регистрирует меню, фильтр, подписку и обработчик снятия лимита', () => {
      const h = initHarness();
      expect(h.bot.use).toHaveBeenCalled();
      expect(h.bot.filter).toHaveBeenCalledTimes(1);
      expect(h.composer.on).toHaveBeenCalledWith(
        ['message', 'channel_post'],
        expect.any(Function)
      );
      expect(h.clientBaseService.bestMemesDaily$.subscribe).toHaveBeenCalledTimes(1);
      expect(h.bot.callbackQuery).toHaveBeenCalledTimes(4);
    });

    it('снятие лимита отклоняется без прав модератора', async () => {
      const h = initHarness();
      h.userService.checkPermission.mockReturnValueOnce(false);
      const handler = h.bot.callbackQuery.mock.calls.find((c: any[]) => String(c[0]).includes('admin_lift_limit'))[1];
      const ctx = makeCtx();

      await handler(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        'Недостаточно прав для снятия лимита'
      );
      expect(h.userService.disableMemeLimitForUser).not.toHaveBeenCalled();
    });

    it('снятие лимита снимает ограничение и редактирует сообщение', async () => {
      const h = initHarness();
      const handler = h.bot.callbackQuery.mock.calls.find((c: any[]) => String(c[0]).includes('admin_lift_limit'))[1];
      const ctx = makeCtx();

      await handler(ctx);

      expect(h.userService.disableMemeLimitForUser).toHaveBeenCalledWith(42, 24);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Лимит снят на 24 часа');
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Лимит снят модератором @mod'),
        { reply_markup: null }
      );
    });

    it('ошибка снятия лимита ловится и сообщается модератору', async () => {
      const h = initHarness();
      h.userService.disableMemeLimitForUser.mockRejectedValueOnce(new Error('db down'));
      const handler = h.bot.callbackQuery.mock.calls.find((c: any[]) => String(c[0]).includes('admin_lift_limit'))[1];
      const ctx = makeCtx();

      await handler(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Ошибка при снятии лимита');
      expect(Logger.error).toHaveBeenCalled();
    });

    it('статусная клавиатура расписания: время, куда и снять', () => {
      const h = initHarness();
      const kb = h.service.scheduledStatusKeyboard(5, '21.09.26 в ~03:30', 'mod', true);
      const flat = kb.inline_keyboard.flat() as any[];
      expect(String(flat[0].text)).toContain('21.09.26 в ~03:30');
      expect(String(flat[0].text)).toContain('кринж');
      expect(flat[1].callback_data).toBe('upsched:unsch:5');
    });

    it('снятие с публикации: подтверждение, отмена и возврат в меню', async () => {
      const h = initHarness();
      h.userService.checkPermission.mockReturnValue(true);
      const ctx = makeCtx();
      const find = (needle: string) =>
        h.bot.callbackQuery.mock.calls.find((c: any[]) => String(c[0]).includes(needle))[1];

      await find('upsched:unschok')({ ...ctx, match: ['upsched:unschok:11', '11'] });
      expect(h.postSchedulerService.removeByRequestMessageId).toHaveBeenCalledWith(11);
      expect(h.bot.api.editMessageReplyMarkup).toHaveBeenCalled();

      h.postSchedulerService.findByRequestMessageId.mockResolvedValue({
        publishDate: new Date(),
        mode: PublicationModesEnum.NIGHT_CRINGE,
      });
      await find('upsched:unschcancel')({ ...ctx, match: ['upsched:unschcancel:11', '11'] });
      expect(h.bot.api.editMessageReplyMarkup).toHaveBeenCalled();

      await find('upsched:unsch')({ ...ctx, match: ['upsched:unsch:11', '11'] });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Снять с публикации?');
    });
  });

  describe('observeDailyBesetMemes', () => {
    function mockQueryBuilder(h: any, posts: any[]) {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(posts),
      };
      h.userRequestRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('уведомляет пользователя с одним лучшим постом и репостит его', async () => {
      const h = createHarness();
      mockQueryBuilder(h, [
        { id: 1, publishedMessageId: 5, user: { id: 42 } },
      ]);
      h.service.observeDailyBesetMemes();
      const cb = h.clientBaseService.bestMemesDaily$.subscribe.mock.calls[0][0];

      await cb({ byLikePostMemeId: 5, byViewPostMemeId: undefined });

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        '🎉 Поздравляем! Твой пост стал одним из лучших за сутки!',
        expect.objectContaining({ reply_markup: expect.anything() })
      );
      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(42, MEME_CHANNEL, 5);
    });

    it('использует множественную формулировку и пропускает пост без publishedMessageId', async () => {
      const h = createHarness();
      mockQueryBuilder(h, [
        { id: 1, publishedMessageId: 5, user: { id: 42 } },
        { id: 2, publishedMessageId: null, user: { id: 42 } },
      ]);
      h.service.observeDailyBesetMemes();
      const cb = h.clientBaseService.bestMemesDaily$.subscribe.mock.calls[0][0];

      await cb({ byLikePostMemeId: 5, byViewPostMemeId: 6 });

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        '🎉 Поздравляем! Твои посты стали лучшими за сутки!',
        expect.anything()
      );
      expect(h.bot.api.forwardMessage).toHaveBeenCalledTimes(1);
    });

    it('игнорирует посты без пользователя', async () => {
      const h = createHarness();
      mockQueryBuilder(h, [{ id: 1, publishedMessageId: 5, user: null }]);
      h.service.observeDailyBesetMemes();
      const cb = h.clientBaseService.bestMemesDaily$.subscribe.mock.calls[0][0];

      await cb({ byLikePostMemeId: undefined, byViewPostMemeId: undefined });

      expect(h.bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('пустой список лучших: не строит запрос и ничего не отправляет', async () => {
      const h = createHarness();
      const qb = mockQueryBuilder(h, []);
      h.service.observeDailyBesetMemes();
      const cb = h.clientBaseService.bestMemesDaily$.subscribe.mock.calls[0][0];

      await cb({});

      expect(qb.where).not.toHaveBeenCalled();
      expect(h.bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('ошибка уведомления логируется и не роняет подписку', async () => {
      const h = createHarness();
      mockQueryBuilder(h, [{ id: 1, publishedMessageId: 5, user: { id: 42 } }]);
      h.bot.api.sendMessage.mockRejectedValueOnce(new Error('blocked'));
      h.service.observeDailyBesetMemes();
      const cb = h.clientBaseService.bestMemesDaily$.subscribe.mock.calls[0][0];

      await expect(
        cb({ byLikePostMemeId: 5, byViewPostMemeId: 6 })
      ).resolves.toBeUndefined();
      expect(Logger.error).toHaveBeenCalled();
    });
  });

  describe('handleUserTextRequest', () => {
    it('пересылает обращение, reply_to_message и пинит копию', async () => {
      const h = createHarness();
      const ctx = makeCtx();
      ctx.message.reply_to_message = { message_id: 5 };

      await h.service.handleUserTextRequest(ctx);

      expect(ctx.react).toHaveBeenCalledWith('👍');
      expect(h.bot.api.sendMessage).toHaveBeenNthCalledWith(
        1,
        REQUEST_CHANNEL,
        expect.stringContaining('📝 Обращение от'),
        { disable_notification: true }
      );
      expect(ctx.api.forwardMessage).toHaveBeenCalledWith(REQUEST_CHANNEL, 42, 5);
      expect(ctx.api.copyMessage).toHaveBeenCalledWith(REQUEST_CHANNEL, 42, 10, {
        disable_notification: true,
      });
      expect(h.bot.api.pinChatMessage).toHaveBeenCalledWith(REQUEST_CHANNEL, 3, {
        disable_notification: true,
      });
      expect(h.userRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ isTextRequest: true, replyToMessageId: 5 })
      );
      expect(h.userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
    });

    it('реагирует эмодзи и собирает флаги премиум/бот/username', async () => {
      const h = createHarness();
      const ctx = makeCtx();
      ctx.message.from = {
        id: 42,
        first_name: 'Иван',
        last_name: undefined,
        username: 'ivan',
        is_bot: true,
        is_premium: true,
      };

      await h.service.handleUserTextRequest(ctx);

      const userText = h.bot.api.sendMessage.mock.calls[0][1];
      expect(userText).toContain('👑');
      expect(userText).toContain('🤖');
      expect(userText).toContain('@ivan');
      expect(ctx.api.forwardMessage).not.toHaveBeenCalled();
    });

    it('без username собирает текст обращения без упоминания', async () => {
      const h = createHarness();
      const ctx = makeCtx();
      ctx.message.from = {
        id: 42,
        first_name: 'Иван',
        last_name: undefined,
        username: undefined,
        is_bot: false,
        is_premium: false,
      };

      await h.service.handleUserTextRequest(ctx);

      const userText = h.bot.api.sendMessage.mock.calls[0][1];
      expect(userText).not.toContain('@');
    });

    it('при ошибке реакции всё равно отвечает и логирует warn', async () => {
      const h = createHarness();
      const ctx = makeCtx();
      ctx.react.mockRejectedValueOnce(new Error('no reaction'));

      await h.service.handleUserTextRequest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Мы получили твоё обращение и скоро ответим'
      );
      expect(Logger.warn).toHaveBeenCalled();
    });

    it('если пересылка reply не удалась — отправляет пояснение', async () => {
      const h = createHarness();
      const ctx = makeCtx();
      ctx.message.reply_to_message = { message_id: 5 };
      ctx.api.forwardMessage.mockRejectedValueOnce(new Error('too old'));

      await h.service.handleUserTextRequest(ctx);

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        REQUEST_CHANNEL,
        expect.stringContaining('не удалось переслать'),
        { disable_notification: true }
      );
    });
  });

  describe('handleUserMemeRequest', () => {
    it('при достижении суточного лимита сохраняет заявку и показывает меню снятия', async () => {
      const h = createHarness();
      h.userRequestService.countUserMemeRequestsLast24h.mockResolvedValue(5);
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('максимум 5 постов в сутки'),
        { reply_to_message_id: 10, parse_mode: 'HTML' }
      );
      expect(h.userRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ fileUniqueId: 'big', possibleDuplicate: false })
      );
      expect(h.userRequestRepo.update).toHaveBeenCalledWith(77, {
        userRequestChannelMessageId: 3,
      });
      expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalled();
    });

    it('лимит отключён — логирует и продолжает обработку', async () => {
      const h = createHarness();
      h.userRepo.findOne.mockResolvedValue({
        id: 42,
        username: 'ivan',
        memeLimitDisabledUntil: new Date(Date.now() + 3600_000),
        strikes: 0,
      });
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(Logger.log).toHaveBeenCalledWith(
        expect.stringContaining('disabled limit'),
        UserPostManagementService.name
      );
      expect(h.userRequestRepo.insert).toHaveBeenCalled();
    });

    it('видео без фото пропускает проверку дубликатов', async () => {
      const h = createHarness();
      const ctx = makeCtx();

      await h.service.handleUserMemeRequest(ctx);

      expect(h.deduplicationService.getPostImageHash).not.toHaveBeenCalled();
      expect(h.userRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ fileUniqueId: null, possibleDuplicate: false })
      );
    });

    it('видео без username, но с флагами бота и премиума', async () => {
      const h = createHarness();
      h.userRepo.findOne.mockResolvedValue({
        id: 42,
        username: undefined,
        is_bot: true,
        is_premium: true,
        memeLimitDisabledUntil: null,
      });
      const ctx = makeCtx();
      ctx.message.from = {
        id: 42,
        first_name: 'Иван',
        last_name: undefined,
        username: undefined,
        is_bot: true,
        is_premium: true,
      };

      await h.service.handleUserMemeRequest(ctx);

      const userText = h.bot.api.sendMessage.mock.calls[0][1];
      expect(userText).toContain('🤖');
      expect(userText).toContain('👑');
      expect(userText).not.toContain('@');
    });

    it.each([
      [{ isPublished: true, isApproved: null }, 'уже был опубликован'],
      [{ isPublished: false, isApproved: true }, 'прошел модерацию'],
      [{ isPublished: false, isApproved: false }, 'был отклонен'],
      [{ isPublished: false, isApproved: null }, 'находится на модерации'],
    ])('дубликат по fileUniqueId (%j) отклоняется автоматически', async (flags, expected) => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValueOnce({ id: 9, ...flags });
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining(expected),
        { reply_to_message_id: 10 }
      );
      expect(h.userRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ isDuplicate: true, isApproved: false, fileUniqueId: 'big' })
      );
      expect(h.userService.updateUserLastActivity).toHaveBeenCalledWith(ctx);
    });

    it('photo-дубликат помечается и пересылается для сравнения', async () => {
      const h = createHarness();
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([
        { distance: 0.9, memePostId: 111 },
        { distance: 0.3, memePostId: 222 },
      ]);
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      const userText = h.bot.api.sendMessage.mock.calls[0][1];
      expect(userText).toContain('Возможный дубликат (совпадение 90%)');
      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(
        REQUEST_CHANNEL,
        MEME_CHANNEL,
        111,
        { disable_notification: true }
      );
      expect(h.userRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ possibleDuplicate: true })
      );
    });

    it('photo-дубликат перебирает совпадения и выбирает лучшее по возрастанию', async () => {
      const h = createHarness();
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([
        { distance: 0.5, memePostId: 111 },
        { distance: 0.9, memePostId: 222 },
      ]);
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(
        REQUEST_CHANNEL,
        MEME_CHANNEL,
        222,
        { disable_notification: true }
      );
    });

    it('ошибка пересылки дубликата ловится', async () => {
      const h = createHarness();
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([
        { distance: 0.9, memePostId: 111 },
      ]);
      h.bot.api.forwardMessage.mockRejectedValueOnce(new Error('forward fail'));
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(Logger.error).toHaveBeenCalled();
      expect(h.userRequestRepo.insert).toHaveBeenCalled();
    });

    it('запланированный дубликат помечается и отправляется с превью', async () => {
      const h = createHarness();
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([]);
      h.deduplicationService.calculateHashDistance.mockReturnValue(0.7);
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 3, hash: 'other', publishDate: new Date('2026-05-01T10:00:00Z') },
      ]);
      h.postSchedulerService.getScheduledPostById.mockResolvedValue({
        requestChannelMessageId: 44,
      });
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      const userText = h.bot.api.sendMessage.mock.calls[0][1];
      expect(userText).toContain('Похожий пост (70%) запланирован');
      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(
        REQUEST_CHANNEL,
        REQUEST_CHANNEL,
        44,
        { disable_notification: true }
      );
      expect(h.userRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ possibleDuplicate: true, scheduledDuplicateId: 3 })
      );
    });

    it('ошибка получения запланированного превью ловится', async () => {
      const h = createHarness();
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([]);
      h.deduplicationService.calculateHashDistance.mockReturnValue(0.7);
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 3, hash: 'other', publishDate: new Date('2026-05-01T10:00:00Z') },
      ]);
      h.postSchedulerService.getScheduledPostById.mockRejectedValue(new Error('db'));
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(Logger.warn).toHaveBeenCalled();
    });

    it('ошибка отправки информации о запланированном дубликате логируется', async () => {
      const h = createHarness();
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([]);
      h.deduplicationService.calculateHashDistance.mockReturnValue(0.7);
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 3, hash: 'other', publishDate: new Date('2026-05-01T10:00:00Z') },
      ]);
      // первый sendMessage (текст заявки) успешен, второй (инфо о дубликате) падает
      h.bot.api.sendMessage
        .mockResolvedValueOnce({ message_id: 1 })
        .mockRejectedValueOnce(new Error('tg fail'));
      const ctx = makeCtx();
      ctx.message.photo = PHOTO;

      await h.service.handleUserMemeRequest(ctx);

      expect(Logger.error).toHaveBeenCalled();
      expect(h.userRequestRepo.insert).toHaveBeenCalled();
    });

    it('ошибка в try-блоке приводит к catch, но обработка продолжается', async () => {
      const h = createHarness();
      const ctx = makeCtx();
      ctx.react.mockRejectedValueOnce(new Error('no react'));

      await h.service.handleUserMemeRequest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Мы все получили и скоро ответим');
      expect(Logger.warn).toHaveBeenCalled();
      expect(h.userRequestRepo.insert).toHaveBeenCalled();
    });
  });

  describe('buildLimitMenu', () => {
    function build(h: any) {
      return captureHandlers(() => (h.service as any).buildLimitMenu())[0][1];
    }

    it('сообщает, если заявка не найдена', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue(null);
      const ctx = makeCtx();

      await build(h)(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Ошибка: сообщение не найдено');
    });

    it('проверяет права модератора', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 1, user: { id: 42 } });
      h.userService.checkPermission.mockReturnValue(false);
      const ctx = makeCtx();

      await build(h)(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Недостаточно прав');
    });

    it('сообщает, если пользователь заявки не найден', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 1, user: null });
      const ctx = makeCtx();

      await build(h)(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Ошибка: пользователь не найден');
    });

    it('снимает лимит без фото и показывает обычное меню', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
      });
      const ctx = makeCtx();

      await build(h)(ctx);

      expect(h.userService.disableMemeLimitForUser).toHaveBeenCalledWith(42, 24);
      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { userRequestChannelMessageId: 100 },
        { possibleDuplicate: false }
      );
      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(42, REQUEST_CHANNEL, 100);
      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Админ снял'),
        { reply_to_message_id: 5 }
      );
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: (h.service as any).moderatedPostMenu,
      });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Лимит снят на 24 часа');
    });

    it('при найденном опубликованном дубликате показывает меню дубликатов', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42, originalMessageId: 5 },
      });
      const ctx = makeCtx();
      ctx.callbackQuery.message.photo = PHOTO;
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([{ distance: 0.6 }]);

      await build(h)(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { userRequestChannelMessageId: 100 },
        { possibleDuplicate: true }
      );
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: (h.service as any).duplicateMenu,
      });
    });

    it('находит дубликат среди запланированных постов', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42, originalMessageId: 5 },
      });
      const ctx = makeCtx();
      ctx.callbackQuery.message.photo = PHOTO;
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([]);
      h.deduplicationService.calculateHashDistance.mockReturnValue(0.8);
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 3, hash: 'other', publishDate: new Date() },
      ]);

      await build(h)(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { userRequestChannelMessageId: 100 },
        { possibleDuplicate: true }
      );
    });

    it('ловит ошибку и сообщает о ней', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockRejectedValueOnce(new Error('db'));
      const ctx = makeCtx();

      await build(h)(ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Произошла ошибка');
      expect(Logger.error).toHaveBeenCalled();
    });
  });

  describe('buildDuplicateMenu', () => {
    function build(h: any) {
      const calls = captureHandlers(() => (h.service as any).buildDuplicateMenu());
      return { confirm: byLabel(calls, '✅ Дубликат'), deny: byLabel(calls, '❌ Не дубликат') };
    }

    it('подтверждённый дубликат запланированного поста уведомляет пользователя', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: 3,
      });
      h.postSchedulerService.getScheduledPostById.mockResolvedValue({
        publishDate: new Date('2026-05-01T10:00:00Z'),
      });
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Похожий пост уже запланирован к публикации'),
        { reply_to_message_id: 5 }
      );
      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ isApproved: false, isDuplicate: true })
      );
      expect(ctx.unpinChatMessage).toHaveBeenCalled();
      expect(ctx.deleteMessage).toHaveBeenCalled();
    });

    it('невалидная дата запланированного поста даёт стандартное сообщение', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: 3,
      });
      h.postSchedulerService.getScheduledPostById.mockResolvedValue({ publishDate: null });
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        'Похожий пост уже запланирован к публикации. Ты можешь предложить что-нибудь другое'
      );
    });

    it('отсутствующий запланированный пост тоже даёт стандартное сообщение', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: 3,
      });
      h.postSchedulerService.getScheduledPostById.mockResolvedValue(null);
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        'Похожий пост уже запланирован к публикации. Ты можешь предложить что-нибудь другое'
      );
    });

    it('обычный дубликат: ищет оригинал и пересылает его пользователю', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: null,
      });
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([
        { distance: 0.4, memePostId: 9 },
        { distance: 0.8, memePostId: 10 },
      ]);
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        'Этот пост уже публиковался, ты можешь предложить что-нибудь другое'
      );
      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(42, MEME_CHANNEL, 10);
      expect(h.userRequestRepo.update).toHaveBeenCalled();
    });

    it('перебор дубликатов оставляет первый при убывании расстояний', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: null,
      });
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([
        { distance: 0.9, memePostId: 10 },
        { distance: 0.4, memePostId: 9 },
      ]);
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(42, MEME_CHANNEL, 10);
    });

    it('без хеша и без дубликатов просто обновляет статус', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: null,
      });
      h.deduplicationService.getPostImageHash.mockResolvedValue(null);
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.bot.api.forwardMessage).not.toHaveBeenCalled();
      expect(h.userRequestRepo.update).toHaveBeenCalled();
    });

    it('ошибка пересылки оригинала логируется', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        scheduledDuplicateId: null,
      });
      h.deduplicationService.getPostImageHash.mockResolvedValue('hash');
      h.deduplicationService.checkDuplicate.mockResolvedValue([{ distance: 0.8, memePostId: 10 }]);
      h.bot.api.forwardMessage.mockRejectedValueOnce(new Error('fail'));
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(Logger.error).toHaveBeenCalled();
    });

    it('без прав модератора подтверждение игнорируется', async () => {
      const h = createHarness();
      h.userService.checkPermission.mockReturnValue(false);
      const ctx = makeCtx();

      await build(h).confirm(ctx);

      expect(h.userRequestRepo.findOne).not.toHaveBeenCalled();
      expect(ctx.deleteMessage).not.toHaveBeenCalled();
    });

    it('«Не дубликат» сбрасывает флаги и меняет меню', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 1, user: { id: 42 } });
      const ctx = makeCtx();

      await build(h).deny(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        {
          possibleDuplicate: false,
          scheduledDuplicateId: null,
          checkedByModerator: 7,
        }
      );
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: (h.service as any).moderatedPostMenu,
      });
    });

    it('если меню не обновилось — пересоздаёт сообщение', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 1, user: { id: 42 } });
      const ctx = makeCtx();
      ctx.editMessageReplyMarkup.mockRejectedValueOnce(new Error('too old'));

      await build(h).deny(ctx);

      expect(ctx.api.deleteMessage).toHaveBeenCalledWith(REQUEST_CHANNEL, 100);
      expect(ctx.api.copyMessage).toHaveBeenCalledWith(REQUEST_CHANNEL, REQUEST_CHANNEL, 100, {
        reply_markup: (h.service as any).moderatedPostMenu,
      });
    });

    it('если и пересоздание упало — логирует вторую ошибку', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 1, user: { id: 42 } });
      const ctx = makeCtx();
      ctx.editMessageReplyMarkup.mockRejectedValueOnce(new Error('too old'));
      ctx.api.copyMessage.mockRejectedValueOnce(new Error('still old'));

      await build(h).deny(ctx);

      expect(Logger.error).toHaveBeenCalledTimes(2);
    });

    it('«Не дубликат» без прав модератора ничего не делает', async () => {
      const h = createHarness();
      h.userService.checkPermission.mockReturnValue(false);
      const ctx = makeCtx();

      await build(h).deny(ctx);

      expect(h.userRequestRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('buildModeratedPostMenu', () => {
    function build(h: any) {
      const calls = captureHandlers(() => (h.service as any).buildModeratedPostMenu());
      const dyn = calls.filter((c) => typeof c[0] === 'function');
      const noCalls = calls.filter((c) => c[0] === 'Нет').map((c) => c[1]);
      return {
        calls,
        approve: byLabel(calls, '👍 Одобрить'),
        reject: byLabel(calls, '👎 Отклонить'),
        approvedLabel: dyn[0][0],
        approvedHandler: dyn[0][1],
        discardLabel: dyn[1][0],
        approvedStatLabel: dyn[2][0],
        lastPostLabel: dyn[3][0],
        rejectLabel: dyn[4][0],
        rejectHandler: dyn[4][1],
        strikeLabel: dyn[5][0],
        strikeHandler: dyn[5][1],
        back: byLabel(calls, 'Назад'),
        restore: byLabel(calls, '🔁'),
        skull: byLabel(calls, '💀'),
        banConfirm: byLabel(calls, 'Точно в бан?'),
        strikeConfirm: byLabel(calls, 'Точно добавить страйк?'),
        banNo: noCalls[0],
        strikeNo: noCalls[1],
      };
    }

    it('«Одобрить» с правом модератора помечает пост и навигирует', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 5 });
      const ctx = makeCtx();

      await build(h).approve(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ isApproved: true, processedByModerator: { id: 7 } })
      );
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.APPROVAL);
    });

    it('«Одобрить» без прав ничего не делает', async () => {
      const h = createHarness();
      h.userService.checkPermission.mockReturnValue(false);
      const ctx = makeCtx();

      await build(h).approve(ctx);

      expect(h.userRequestRepo.findOne).not.toHaveBeenCalled();
    });

    it('«Отклонить» с фото сохраняет fileUniqueId и уведомляет пользователя', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        originalMessageId: 11,
        user: { id: 42 },
      });
      const ctx = makeCtx();
      ctx.callbackQuery.message.photo = PHOTO;

      await build(h).reject(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ fileUniqueId: 'big', isApproved: false })
      );
      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        'Мы не можем такое опубликовать, твой пост отклонен'
      );
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.REJECT);
    });

    it('«Отклонить» без фото не пишет fileUniqueId', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        originalMessageId: 11,
        user: { id: 42 },
      });
      const ctx = makeCtx();

      await build(h).reject(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ fileUniqueId: null })
      );
    });

    it('«Отклонить» без callbackQuery.message не падает на photo', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        originalMessageId: 11,
        user: { id: 42 },
      });
      const ctx = makeCtx();
      ctx.callbackQuery = { from: { id: 7, username: 'mod' } };

      await build(h).reject(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ fileUniqueId: null })
      );
    });

    it('«Отклонить» вызывает forwardMessage через catch (ошибка не обрабатывается)', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        originalMessageId: 11,
        user: { id: 42 },
      });
      const ctx = makeCtx();

      await expect(build(h).reject(ctx)).resolves.toBeUndefined();
      expect(h.bot.api.forwardMessage).toHaveBeenCalledWith(42, 42, 11);
      expect(h.bot.api.sendMessage).toHaveBeenCalled();
    });

    it('динамические подписи кнопок возвращают данные из статистики', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        processedByModerator: { username: 'mod' },
      });
      const b = build(h);

      await expect(b.approvedLabel(makeCtx())).resolves.toBe(
        '✅ Опубликовать (mod)'
      );
      await expect(b.discardLabel(makeCtx())).resolves.toBe('👎 1 (0)');
      await expect(b.approvedStatLabel(makeCtx())).resolves.toBe('👍 2 (1)');
      await expect(b.lastPostLabel(makeCtx())).resolves.toBe('🗓 2 дня назад');
    });

    it('публикация доступна только с правом и ведёт в PUBLICATION', async () => {
      const h = createHarness();
      const b = build(h);
      const ctx = makeCtx();

      await b.approvedHandler(ctx);
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.PUBLICATION);

      h.userService.checkPermission.mockReturnValue(false);
      const ctx2 = makeCtx();
      await b.approvedHandler(ctx2);
      expect(ctx2.menu.nav).not.toHaveBeenCalled();
    });

    it('все кнопки публикации вызывают onPublishActions с нужным режимом', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      h.userRepo.findOne.mockResolvedValue({ username: 'mod' });
      const b = build(h);
      const modes: Array<[string, PublicationModesEnum]> = [
        ['Кринж', PublicationModesEnum.NIGHT_CRINGE],
        ['Сейчас', PublicationModesEnum.NOW_SILENT],
        ['Ближайший слот', PublicationModesEnum.NEXT_INTERVAL],
        ['Ночью', PublicationModesEnum.NEXT_NIGHT],
        ['Утром', PublicationModesEnum.NEXT_MORNING],
        ['Днем', PublicationModesEnum.NEXT_MIDDAY],
        ['Вечером', PublicationModesEnum.NEXT_EVENING],
      ];

      for (const [label, mode] of modes) {
        const handler = byLabel(b.calls, label);
        const spy = jest.spyOn(h.service, 'onPublishActions' as any);
        await handler(makeCtx());
        expect(spy).toHaveBeenCalledWith(expect.anything(), mode);
        spy.mockRestore();
      }
    });

    it('«Назад» возвращает в APPROVAL', async () => {
      const h = createHarness();
      const ctx = makeCtx();

      await build(h).back(ctx);

      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.APPROVAL);
    });

    it('подпись отклонения открепляет сообщение', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        processedByModerator: { username: 'mod' },
      });
      const ctx = makeCtx();

      const text = await build(h).rejectLabel(ctx);

      expect(ctx.unpinChatMessage).toHaveBeenCalledWith(100);
      expect(text).toBe('👨 Отклонен ❌ (mod)');
    });

    it('удаление отклонённого поста требует права', async () => {
      const h = createHarness();
      const b = build(h);

      const allowed = makeCtx();
      await b.rejectHandler(allowed);
      expect(allowed.deleteMessage).toHaveBeenCalled();

      h.userService.checkPermission.mockReturnValue(false);
      const denied = makeCtx();
      await b.rejectHandler(denied);
      expect(denied.deleteMessage).not.toHaveBeenCalled();
    });

    it('восстановление после отклонения требует права', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      const b = build(h);
      const ctx = makeCtx();

      await b.restore(ctx);
      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ restoredBy: 7, isApproved: true })
      );
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.APPROVAL);
    });

    it('подпись страйков показывает счётчик', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ user: { strikes: 3 } });
      const b = build(h);

      await expect(b.strikeLabel(makeCtx())).resolves.toBe('❗ 3');

      h.userRequestRepo.findOne.mockResolvedValue({ user: {} });
      await expect(b.strikeLabel(makeCtx())).resolves.toBe('❗ 0');
    });

    it('страйк доступен только с правом', async () => {
      const h = createHarness();
      const b = build(h);
      const ctx = makeCtx();

      await b.strikeHandler(ctx);
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.STRIKE);
    });

    it('«💀» подтверждает бан и навигирует', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      const b = build(h);
      const ctx = makeCtx();

      await b.skull(ctx);

      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ restoredBy: 7, isApproved: true })
      );
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.BAN);
    });

    it('подтверждение бана банит и удаляет сообщение', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ user: { id: 42, strikes: 0 } });
      const b = build(h);
      const ctx = makeCtx();

      await b.banConfirm(ctx);

      expect(h.userRepo.update).toHaveBeenCalledWith(
        { id: 42 },
        expect.objectContaining({ isBanned: true, bannedBy: 7 })
      );
      expect(ctx.deleteMessage).toHaveBeenCalled();
    });

    it('подтверждение бана без права ничего не делает', async () => {
      const h = createHarness();
      h.userService.checkPermission.mockReturnValue(false);
      const b = build(h);
      const ctx = makeCtx();

      await b.banConfirm(ctx);

      expect(h.userRepo.update).not.toHaveBeenCalled();
    });

    it('«Нет» в подтверждении бана возвращает в REJECT', async () => {
      const h = createHarness();
      const ctx = makeCtx();

      await build(h).banNo(ctx);

      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.REJECT);
    });

    it('подтверждение страйка добавляет страйк', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ user: { id: 42, strikes: 2 } });
      const b = build(h);
      const ctx = makeCtx();

      await b.strikeConfirm(ctx);

      expect(h.userRepo.update).toHaveBeenCalledWith({ id: 42 }, { strikes: 3 });
      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.REJECT);
    });

    it('страйк без существующего счётчика начинает с 1', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ user: { id: 42 } });
      const b = build(h);

      await b.strikeConfirm(makeCtx());

      expect(h.userRepo.update).toHaveBeenCalledWith({ id: 42 }, { strikes: 1 });
    });

    it('«Нет» в подтверждении страйка возвращает в REJECT', async () => {
      const h = createHarness();
      const ctx = makeCtx();

      await build(h).strikeNo(ctx);

      expect(ctx.menu.nav).toHaveBeenCalledWith(PostModerationMenusEnum.REJECT);
    });
  });

  describe('onPublishActions / публикация', () => {
    it('без права публикации сразу выходит', async () => {
      const h = createHarness();
      h.userService.checkPermission.mockReturnValue(false);
      const ctx = makeCtx();

      await h.service.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT);

      expect(ctx.unpinChatMessage).not.toHaveBeenCalled();
    });

    it('NOW_SILENT публикует немедленно', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 5, user: { id: 42 } });
      const ctx = makeCtx();
      ctx.callbackQuery.message.caption = 'подпись';

      await h.service.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT);

      expect(ctx.unpinChatMessage).toHaveBeenCalledWith(100);
      expect(h.bot.api.copyMessage).toHaveBeenCalledWith(
        MEME_CHANNEL,
        REQUEST_CHANNEL,
        100,
        expect.objectContaining({ caption: 'подпись\n\n', parse_mode: 'HTML' })
      );
      expect(h.userRequestRepo.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ isPublished: true, publishedBy: 7 })
      );
      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Присылай еще!'),
        { parse_mode: 'HTML' }
      );
    });

    it('NEXT_* ставит пост в расписание', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      const ctx = makeCtx();

      await h.service.onPublishActions(ctx, PublicationModesEnum.NEXT_MORNING);

      expect(h.postSchedulerService.addPostToSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ mode: PublicationModesEnum.NEXT_MORNING })
      );
      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Твой пост будет опубликован'),
        { parse_mode: 'HTML' }
      );
    });

    it('NEXT_INTERVAL тоже идёт в расписание', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      await h.service.onPublishActions(makeCtx(), PublicationModesEnum.NEXT_INTERVAL);
      expect(h.postSchedulerService.addPostToSchedule).toHaveBeenCalled();
    });

    it('NEXT_MIDDAY, NEXT_EVENING, NEXT_NIGHT идут в расписание', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      for (const mode of [
        PublicationModesEnum.NEXT_MIDDAY,
        PublicationModesEnum.NEXT_EVENING,
        PublicationModesEnum.NEXT_NIGHT,
      ]) {
        await h.service.onPublishActions(makeCtx(), mode);
      }
      expect(h.postSchedulerService.addPostToSchedule).toHaveBeenCalledTimes(3);
    });

    it('NIGHT_CRINGE создаёт запись кринжа и ставит в расписание', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });
      const ctx = makeCtx();

      await h.service.onPublishActions(ctx, PublicationModesEnum.NIGHT_CRINGE);

      expect(h.cringeManagementService.repository.insert).toHaveBeenCalledWith({
        requestChannelMessageId: 100,
        isUserPost: true,
      });
      expect(h.postSchedulerService.addPostToSchedule).toHaveBeenCalled();
    });

    it('onPublishActions терпит пропажу callbackQuery.message в апдейте', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 5, user: { id: 42 } });
      const ctx = makeCtx();
      const realMessage = ctx.callbackQuery.message;
      let reads = 0;
      delete ctx.callbackQuery.message;
      Object.defineProperty(ctx.callbackQuery, 'message', {
        configurable: true,
        get: () => {
          reads += 1;
          // сообщение есть при первом доступе и "исчезает" на необязательных проверках
          return reads % 2 === 1 ? realMessage : undefined;
        },
      });

      await h.service.onPublishActions(ctx, PublicationModesEnum.NOW_SILENT);

      expect(ctx.unpinChatMessage).toHaveBeenCalled();
      expect(h.bot.api.copyMessage).toHaveBeenCalled();
    });

    it('неизвестный режим не публикует', async () => {
      const h = createHarness();
      const ctx = makeCtx();

      await h.service.onPublishActions(ctx, 'UNKNOWN' as any);

      expect(h.postSchedulerService.addPostToSchedule).not.toHaveBeenCalled();
      expect(ctx.unpinChatMessage).toHaveBeenCalled();
    });

    it('publishScheduled выходит, если слот не найден', async () => {
      const h = createHarness();
      h.postSchedulerService.addPostToSchedule.mockResolvedValue(null);

      await (h.service as any).publishScheduled(publishContext(PublicationModesEnum.NEXT_MORNING));

      expect(h.bot.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it('publishScheduled для NIGHT_CRINGE добавляет ссылку на канал', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });

      await (h.service as any).publishScheduled(publishContext(PublicationModesEnum.NIGHT_CRINGE));

      expect(h.settingsService.cringeChannelHtmlLink).toHaveBeenCalled();
      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('особую рубрику'),
        { parse_mode: 'HTML' }
      );
    });

    it('onPublishNow для NIGHT_CRINGE обновляет кринж-запись', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({ id: 5, user: { id: 42 } });
      const ctx = publishContext(PublicationModesEnum.NIGHT_CRINGE);

      await h.service.onPublishNow(ctx);

      expect(h.cringeManagementService.repository.update).toHaveBeenCalledWith(
        { requestChannelMessageId: 100 },
        { memeChannelMessageId: 3 }
      );
      expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Утром пост будет перемещен'),
        { parse_mode: 'HTML' }
      );
      expect(h.deduplicationService.createPublishedPostHash).toHaveBeenCalledWith('hash', 3);
      expect(h.trollService.maybeRepostMeme).toHaveBeenCalledWith(MEME_CHANNEL, 3);
    });

    it('publishNightCringeScheduled вставляет запись и делегирует в расписание', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 5,
        user: { id: 42 },
        originalMessageId: 11,
      });

      await (h.service as any).publishNightCringeScheduled(
        publishContext(PublicationModesEnum.NIGHT_CRINGE)
      );

      expect(h.cringeManagementService.repository.insert).toHaveBeenCalled();
      expect(h.postSchedulerService.addPostToSchedule).toHaveBeenCalled();
    });
  });

  describe('checkScheduledDuplicates / isValidDate', () => {
    it('без хеша возвращает null', async () => {
      const h = createHarness();
      await expect((h.service as any).checkScheduledDuplicates('')).resolves.toBeNull();
      expect(h.postSchedulerService.getAllScheduledPosts).not.toHaveBeenCalled();
    });

    it('возвращает null без запланированных постов', async () => {
      const h = createHarness();
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([]);
      await expect((h.service as any).checkScheduledDuplicates('h')).resolves.toBeNull();
    });

    it('выбирает самый похожий валидный пост', async () => {
      const h = createHarness();
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 1, hash: 'a', publishDate: new Date() },
        { id: 2, hash: 'b', publishDate: new Date() },
      ]);
      h.deduplicationService.calculateHashDistance
        .mockReturnValueOnce(0.6)
        .mockReturnValueOnce(0.9);

      const result = await (h.service as any).checkScheduledDuplicates('h');

      expect(result).toEqual(
        expect.objectContaining({ postId: 2, distance: 0.9 })
      );
    });

    it('сортировка reduce оставляет первый при убывании расстояний', async () => {
      const h = createHarness();
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 1, hash: 'a', publishDate: new Date() },
        { id: 2, hash: 'b', publishDate: new Date() },
      ]);
      h.deduplicationService.calculateHashDistance
        .mockReturnValueOnce(0.9)
        .mockReturnValueOnce(0.6);

      const result = await (h.service as any).checkScheduledDuplicates('h');

      expect(result).toEqual(expect.objectContaining({ postId: 1, distance: 0.9 }));
    });

    it('пропускает посты без хеша или даты', async () => {
      const h = createHarness();
      h.postSchedulerService.getAllScheduledPosts.mockResolvedValue([
        { id: 1, hash: null, publishDate: new Date() },
        { id: 2, hash: 'a', publishDate: null },
        { id: 3, hash: 'b', publishDate: 'not-a-date' },
      ]);

      await expect((h.service as any).checkScheduledDuplicates('h')).resolves.toBeNull();
      expect(h.deduplicationService.calculateHashDistance).not.toHaveBeenCalled();
    });

    it('ловит ошибку загрузки расписания', async () => {
      const h = createHarness();
      h.postSchedulerService.getAllScheduledPosts.mockRejectedValue(new Error('db'));
      await expect((h.service as any).checkScheduledDuplicates('h')).resolves.toBeNull();
      expect(Logger.error).toHaveBeenCalled();
    });

    it('isValidDate понимает Date, строки, числа и мусор', () => {
      const fn = (h: any) => h.service.isValidDate.bind(h.service);
      const h = createHarness();
      expect(fn(h)(null)).toBe(false);
      expect(fn(h)(new Date())).toBe(true);
      expect(fn(h)('2026-01-01')).toBe(true);
      // 0 — falsy, поэтому считается отсутствием даты
      expect(fn(h)(0)).toBe(false);
      expect(fn(h)('definitely not a date')).toBe(false);
    });
  });

  describe('handleAdminUserResponse', () => {
    function init(h: any) {
      const composer = { on: jest.fn() };
      h.bot.filter.mockReturnValue(composer);
      (h.service as any).prepareReplyToBotContext();
      (h.service as any).handleAdminUserResponse();
      return composer.on.mock.calls[0][1];
    }

    it('копирует ответ админа пользователю и снимает реакцию', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        userRequestChannelMessageId: 100,
        isTextRequest: true,
      });
      const handler = init(h);
      const ctx = makeCtx();
      ctx.message = {
        message_id: 200,
        reply_to_message: { message_id: 100 },
        chat: { id: REQUEST_CHANNEL },
      };
      ctx.chat = { id: REQUEST_CHANNEL };

      await handler(ctx);

      expect(h.bot.api.setMessageReaction).toHaveBeenCalledWith(42, 5, []);
      expect(h.bot.api.copyMessage).toHaveBeenCalledWith(42, REQUEST_CHANNEL, 200, {
        reply_to_message_id: 5,
      });
      expect(h.bot.api.unpinChatMessage).toHaveBeenCalledWith(REQUEST_CHANNEL, 100);
    });

    it('игнорирует ответ, если заявка не найдена', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue(null);
      const handler = init(h);
      const ctx = makeCtx();
      ctx.message = {
        message_id: 200,
        reply_to_message: { message_id: 100 },
        chat: { id: REQUEST_CHANNEL },
      };
      ctx.chat = { id: REQUEST_CHANNEL };

      await handler(ctx);

      expect(h.bot.api.copyMessage).not.toHaveBeenCalled();
      expect(Logger.warn).toHaveBeenCalled();
    });

    it('игнорирует апдейт без reply_to_message', async () => {
      const h = createHarness();
      const handler = init(h);
      const ctx = makeCtx();
      ctx.message = { message_id: 200, chat: { id: REQUEST_CHANNEL } };
      ctx.chat = { id: REQUEST_CHANNEL };

      await handler(ctx);

      expect(h.userRequestRepo.findOne).not.toHaveBeenCalled();
    });

    it('ошибки реакций и открепления не роняют обработчик', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        userRequestChannelMessageId: 100,
        isTextRequest: true,
      });
      h.bot.api.setMessageReaction.mockRejectedValueOnce(new Error('no reaction'));
      h.bot.api.unpinChatMessage.mockRejectedValueOnce(new Error('no unpin'));
      const handler = init(h);
      const ctx = makeCtx();
      ctx.message = {
        message_id: 200,
        reply_to_message: { message_id: 100 },
        chat: { id: REQUEST_CHANNEL },
      };
      ctx.chat = { id: REQUEST_CHANNEL };

      await handler(ctx);

      expect(Logger.warn).toHaveBeenCalledTimes(2);
    });

    it('для медиа-заявки (не текст) не открепляет', async () => {
      const h = createHarness();
      h.userRequestRepo.findOne.mockResolvedValue({
        id: 1,
        user: { id: 42 },
        originalMessageId: 5,
        isTextRequest: false,
      });
      const handler = init(h);
      const ctx = makeCtx();
      ctx.message = {
        message_id: 200,
        reply_to_message: { message_id: 100 },
        chat: { id: REQUEST_CHANNEL },
      };
      ctx.chat = { id: REQUEST_CHANNEL };

      await handler(ctx);

      expect(h.bot.api.unpinChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('prepareReplyToBotContext', () => {
    it('фильтр пропускает только ответы с найденной заявкой', async () => {
      const h = createHarness();
      h.bot.filter.mockReturnValue({ on: jest.fn() });
      (h.service as any).prepareReplyToBotContext();
      const filter = h.bot.filter.mock.calls[0][0];

      h.userRequestRepo.findOne.mockResolvedValueOnce({ id: 1 });
      await expect(
        filter(
          Object.assign(makeCtx(), {
            message: {
              message_id: 200,
              reply_to_message: { message_id: 100 },
              chat: { id: REQUEST_CHANNEL },
            },
            chat: { id: REQUEST_CHANNEL },
          })
        )
      ).resolves.toBe(true);

      h.userRequestRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        filter(
          Object.assign(makeCtx(), {
            message: {
              message_id: 201,
              reply_to_message: { message_id: 101 },
              chat: { id: REQUEST_CHANNEL },
            },
            chat: { id: REQUEST_CHANNEL },
          })
        )
      ).resolves.toBe(false);
    });

    it('фильтр отклоняет апдейт не из канала обращений', async () => {
      const h = createHarness();
      h.bot.filter.mockReturnValue({ on: jest.fn() });
      (h.service as any).prepareReplyToBotContext();
      const filter = h.bot.filter.mock.calls[0][0];

      await expect(
        filter({ message: { message_id: 200 }, chat: { id: -999 } })
      ).resolves.toBe(false);
      expect(h.userRequestRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('sendToMattermost / getTelegramFileUrl', () => {
    it('getTelegramFileUrl достаёт file_id из photo и строит prod-ссылку', async () => {
      const h = createHarness();
      h.bot.api.forwardMessage.mockResolvedValue({
        photo: [{ file_id: 'p1' }, { file_id: 'p2' }],
      });
      h.bot.api.getFile.mockResolvedValue({ file_path: 'photos/x.jpg' });

      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toBe(
        'https://api.telegram.org/file/botTOKEN/photos/x.jpg'
      );
      expect(h.bot.api.getFile).toHaveBeenCalledWith('p2');
    });

    it('getTelegramFileUrl поддерживает video, document, animation', async () => {
      const h = createHarness();

      h.bot.api.forwardMessage.mockResolvedValue({ video: { file_id: 'v' } });
      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toContain('/botTOKEN/');
      expect(h.bot.api.getFile).toHaveBeenLastCalledWith('v');

      h.bot.api.forwardMessage.mockResolvedValue({ document: { file_id: 'd' } });
      await (h.service as any).getTelegramFileUrl(5);
      expect(h.bot.api.getFile).toHaveBeenLastCalledWith('d');

      h.bot.api.forwardMessage.mockResolvedValue({ animation: { file_id: 'a' } });
      await (h.service as any).getTelegramFileUrl(5);
      expect(h.bot.api.getFile).toHaveBeenLastCalledWith('a');
    });

    it('getTelegramFileUrl возвращает undefined без медиа и без file_path', async () => {
      const h = createHarness();
      h.bot.api.forwardMessage.mockResolvedValue({});
      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toBeUndefined();

      h.bot.api.forwardMessage.mockResolvedValue({ video: { file_id: 'v' } });
      h.bot.api.getFile.mockResolvedValue({});
      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toBeUndefined();
    });

    it('getTelegramFileUrl возвращает undefined, если getFile не вернул файл', async () => {
      const h = createHarness();
      h.bot.api.forwardMessage.mockResolvedValue({ video: { file_id: 'v' } });
      h.bot.api.getFile.mockResolvedValue(null);

      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toBeUndefined();
    });

    it('getTelegramFileUrl в тестовом окружении добавляет /test/', async () => {
      const h = createHarness();
      h.baseConfigService.tgEnv = 'test';
      h.bot.api.forwardMessage.mockResolvedValue({ video: { file_id: 'v' } });
      h.bot.api.getFile.mockResolvedValue({ file_path: 'v.mp4' });

      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toBe(
        'https://api.telegram.org/file/botTOKEN/test/v.mp4'
      );
    });

    it('getTelegramFileUrl ловит ошибку и возвращает undefined', async () => {
      const h = createHarness();
      h.bot.api.forwardMessage.mockRejectedValue(new Error('api down'));

      await expect((h.service as any).getTelegramFileUrl(5)).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('sendToMattermost отправляет файл в Mattermost', async () => {
      const h = createHarness();
      h.bot.api.forwardMessage.mockResolvedValue({ photo: [{ file_id: 'p' }] });

      await (h.service as any).sendToMattermost(5, 'caption');

      expect(h.mattermostService.sendPostWithFile).toHaveBeenCalledWith({
        message: 'caption',
        fileUrl: 'https://api.telegram.org/file/botTOKEN/p/f.jpg',
        fileName: 'meme_5',
      });
    });

    it('sendToMattermost логирует ошибку отправки', async () => {
      const h = createHarness();
      h.bot.api.forwardMessage.mockResolvedValue({ photo: [{ file_id: 'p' }] });
      h.mattermostService.sendPostWithFile.mockRejectedValue(new Error('mm down'));

      await (h.service as any).sendToMattermost(5, 'caption');

      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });
});
