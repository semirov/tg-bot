jest.mock('rxjs', () => {
  const actual = jest.requireActual('rxjs');
  return { ...actual, timer: jest.fn(() => actual.of(0)) };
});

import { Menu } from '@grammyjs/menu';
import { UserModeratedPostService } from './user-moderated-post.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';

const flush = async () => {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
};

type CapturedText = { menuId: string; label: string; handler: (ctx: any) => any };

function setup() {
  const userModeratedPostEntity = {
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const userMessageModeratedPostEntity = {
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const userService = {
    changeUserModeratedMode: jest.fn().mockResolvedValue(undefined),
    getUsersForPostModerate: jest.fn(),
  };
  const bot = {
    api: {
      copyMessage: jest.fn().mockResolvedValue({ message_id: 100 }),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    },
  };
  const baseConfigService = { userRequestMemeChannel: -200 };

  const service = new UserModeratedPostService(
    userModeratedPostEntity as any,
    userMessageModeratedPostEntity as any,
    userService as any,
    bot as any,
    baseConfigService as any
  );

  return {
    service,
    userModeratedPostEntity,
    userMessageModeratedPostEntity,
    userService,
    bot,
    baseConfigService,
  };
}

function makeCtx(overrides: any = {}) {
  return {
    from: { id: 5, username: 'user' },
    session: {},
    callbackQuery: { from: { id: 5 }, message: { message_id: 11 } },
    editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
    api: { copyMessage: jest.fn().mockResolvedValue({ message_id: 100 }) },
    ...overrides,
  };
}

function context(overrides: any = {}) {
  return {
    mode: PublicationModesEnum.NOW_SILENT,
    requestChannelMessageId: 11,
    processedByModerator: 5,
    caption: 'подпись',
    isUserPost: false,
    hash: 'hash',
    ...overrides,
  };
}

describe('UserModeratedPostService', () => {
  let captured: CapturedText[] = [];

  beforeEach(() => {
    captured = [];
    jest.spyOn(Menu.prototype, 'text').mockImplementation(function (
      this: any,
      label: any,
      ...middleware: any[]
    ) {
      captured.push({
        menuId: this.id,
        label: typeof label === 'string' ? label : label.text,
        handler: middleware[0],
      });
      return this;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function handlerFor(label: string) {
    const entry = captured.find((item) => item.menuId === 'USER_POST_MODERATE' && item.label === label);
    if (!entry) throw new Error(`Не найден обработчик ${label}`);
    return entry.handler;
  }

  describe('userModeratedPost$', () => {
    it('отдаёт значения из внутреннего субъекта', () => {
      const { service } = setup();
      const received: any[] = [];
      service.userModeratedPost$.subscribe((value) => received.push(value));

      (service as any).userModeratedPostSubject.next({ mode: PublicationModesEnum.NOW_SILENT });
      expect(received).toEqual([{ mode: PublicationModesEnum.NOW_SILENT }]);
    });
  });

  describe('handleCron', () => {
    it('запускает обработку следующего поста', async () => {
      const { service } = setup();
      const spy = jest
        .spyOn(service as any, 'handleNextUserModeratedPost')
        .mockResolvedValue(undefined);

      await service.handleCron();

      expect(spy).toHaveBeenCalled();
    });
  });

  describe('buildUserModeratePost', () => {
    it('создаёт меню и связывает кнопки с обработчиками', async () => {
      const { service } = setup();
      const voteSpy = jest.spyOn(service as any, 'processUserVote').mockResolvedValue(undefined);
      const discardSpy = jest
        .spyOn(service as any, 'discardModerateByUser')
        .mockResolvedValue(undefined);

      const menu = service.buildUserModeratePost();

      expect(menu).toBeInstanceOf(Menu);
      expect(captured.map((item) => item.label).sort()).toEqual(
        ['Не хочу оценивать посты', '👍', '👎'].sort()
      );

      await handlerFor('👍')(makeCtx());
      await handlerFor('👎')(makeCtx());
      await handlerFor('Не хочу оценивать посты')(makeCtx());

      expect(voteSpy).toHaveBeenNthCalledWith(1, expect.anything(), true);
      expect(voteSpy).toHaveBeenNthCalledWith(2, expect.anything(), false);
      expect(discardSpy).toHaveBeenCalled();
    });
  });

  describe('discardModerateByUser', () => {
    it('отключает режим модерации и уменьшает счётчик', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity, userService } =
        setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({ id: 1, moderatedUsersCount: 3 });
      const ctx = makeCtx();

      await (service as any).discardModerateByUser(ctx);

      expect(ctx.session.canBeModeratePosts).toBe(false);
      expect(userService.changeUserModeratedMode).toHaveBeenCalledWith(5, false);
      expect(userModeratedPostEntity.update).toHaveBeenCalledWith(
        { id: 1 },
        { moderatedUsersCount: 2 }
      );
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: expect.anything(),
      });
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Если снова захочешь'));
    });

    it('не падает, если клавиатуру изменить нельзя', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity } = setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({ id: 1, moderatedUsersCount: 1 });
      const ctx = makeCtx({
        editMessageReplyMarkup: jest.fn().mockRejectedValue(new Error('too old')),
      });

      await expect((service as any).discardModerateByUser(ctx)).resolves.toBeUndefined();
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  describe('moderateViaUsers', () => {
    it('создаёт запись модерации и рассылает сообщения пользователям', async () => {
      const {
        service,
        userModeratedPostEntity,
        userMessageModeratedPostEntity,
        userService,
      } = setup();
      service.buildUserModeratePost();
      userService.getUsersForPostModerate.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const ctx = makeCtx();

      const count = await service.moderateViaUsers(ctx, context());

      expect(count).toBe(2);
      expect(userModeratedPostEntity.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestChannelMessageId: 11,
          mode: PublicationModesEnum.NOW_SILENT,
          isApproved: false,
          processedByModerator: 5,
          caption: 'подпись',
          moderatedUsersCount: 2,
          hash: 'hash',
        })
      );
      const insertArg = userModeratedPostEntity.insert.mock.calls[0][0];
      expect(insertArg.moderatedTo).toBeInstanceOf(Date);

      await flush();

      expect(ctx.api.copyMessage).toHaveBeenCalledTimes(2);
      expect(userMessageModeratedPostEntity.insert).toHaveBeenCalledTimes(2);
      expect(userMessageModeratedPostEntity.insert).toHaveBeenCalledWith({
        userId: 1,
        userMessageId: 100,
        requestChannelMessageId: 11,
      });
    });

    it('возвращает 0 и не рассылает ничего без пользователей', async () => {
      const { service, userModeratedPostEntity, userService, bot } = setup();
      userService.getUsersForPostModerate.mockResolvedValue([]);

      const count = await service.moderateViaUsers(makeCtx(), context());

      expect(count).toBe(0);
      expect(userModeratedPostEntity.insert).toHaveBeenCalledWith(
        expect.objectContaining({ moderatedUsersCount: 0 })
      );
      expect(bot.api.copyMessage).not.toHaveBeenCalled();
    });
  });

  describe('processUserModerateMessage', () => {
    it('копирует пост пользователю и сохраняет его сообщение', async () => {
      const { service, userMessageModeratedPostEntity, baseConfigService } = setup();
      service.buildUserModeratePost();
      const ctx = makeCtx();

      await (service as any).processUserModerateMessage(ctx, 7, context());

      expect(ctx.api.copyMessage).toHaveBeenCalledWith(
        7,
        baseConfigService.userRequestMemeChannel,
        11,
        { reply_markup: expect.anything() }
      );
      expect(userMessageModeratedPostEntity.insert).toHaveBeenCalledWith({
        userId: 7,
        userMessageId: 100,
        requestChannelMessageId: 11,
      });
    });

    it('отключает модерацию у пользователя при ошибке копирования', async () => {
      const { service, userService, userMessageModeratedPostEntity } = setup();
      const ctx = makeCtx({
        api: { copyMessage: jest.fn().mockRejectedValue(new Error('blocked')) },
      });

      await (service as any).processUserModerateMessage(ctx, 7, context());

      expect(userService.changeUserModeratedMode).toHaveBeenCalledWith(7, false);
      expect(userMessageModeratedPostEntity.insert).not.toHaveBeenCalled();
    });
  });

  describe('getModeratedContextByCtx', () => {
    it('находит пост модерации по сообщению пользователя', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity } = setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({ id: 2 });

      const result = await (service as any).getModeratedContextByCtx(makeCtx());

      expect(userMessageModeratedPostEntity.findOne).toHaveBeenCalledWith({
        where: { userMessageId: 11 },
      });
      expect(userModeratedPostEntity.findOne).toHaveBeenCalledWith({
        where: { requestChannelMessageId: 11 },
      });
      expect(result).toEqual({ id: 2 });
    });
  });

  describe('processUserVote', () => {
    it('увеличивает лайки при голосе за', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity } = setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 2,
        dislikes: 1,
        requestChannelMessageId: 11,
      });
      const ctx = makeCtx();

      await (service as any).processUserVote(ctx, true);

      expect(ctx.session.userVoted).toBe(true);
      expect(userModeratedPostEntity.update).toHaveBeenCalledWith(
        { id: 1 },
        { likes: 3, dislikes: 1 }
      );
      expect(userMessageModeratedPostEntity.update).toHaveBeenCalledWith(
        { userId: 5, requestChannelMessageId: 11 },
        { voted: true }
      );
    });

    it('увеличивает дизлайки при голосе против', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity } = setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 2,
        dislikes: 1,
        requestChannelMessageId: 11,
      });

      await (service as any).processUserVote(makeCtx(), false);

      expect(userModeratedPostEntity.update).toHaveBeenCalledWith(
        { id: 1 },
        { likes: 2, dislikes: 2 }
      );
    });

    it('закрывает клавиатуру, если пост уже решён', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity } = setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 0,
        dislikes: 0,
        isApproved: true,
        requestChannelMessageId: 11,
      });
      const ctx = makeCtx();

      await (service as any).processUserVote(ctx, true);

      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledTimes(2);
    });

    it('проглатывает ошибку редактирования клавиатуры', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity } = setup();
      userMessageModeratedPostEntity.findOne.mockResolvedValue({ requestChannelMessageId: 11 });
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 0,
        dislikes: 0,
        isRejected: true,
        requestChannelMessageId: 11,
      });
      const ctx = makeCtx({
        editMessageReplyMarkup: jest.fn().mockRejectedValue(new Error('expired')),
      });

      await expect((service as any).processUserVote(ctx, true)).resolves.toBeUndefined();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleNextUserModeratedPost', () => {
    it('ничего не делает без поста', async () => {
      const { service, userModeratedPostEntity } = setup();
      userModeratedPostEntity.findOne.mockResolvedValue(null);

      await (service as any).handleNextUserModeratedPost();

      expect(userModeratedPostEntity.update).not.toHaveBeenCalled();
    });

    it('одобряет пост с большим числом лайков и уведомляет пользователей', async () => {
      const {
        service,
        userModeratedPostEntity,
        userMessageModeratedPostEntity,
        bot,
      } = setup();
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 3,
        dislikes: 1,
        mode: PublicationModesEnum.NOW_SILENT,
        requestChannelMessageId: 11,
        processedByModerator: 5,
        caption: 'подпись',
        hash: 'hash',
      });
      userMessageModeratedPostEntity.find.mockResolvedValue([
        { userId: 1, userMessageId: 50 },
        { userId: 2, userMessageId: 51 },
      ]);
      const received: any[] = [];
      service.userModeratedPost$.subscribe((value) => received.push(value));

      await (service as any).handleNextUserModeratedPost();

      expect(userModeratedPostEntity.update).toHaveBeenCalledWith({ id: 1 }, { isApproved: true });
      expect(received).toEqual([
        {
          mode: PublicationModesEnum.NOW_SILENT,
          requestChannelMessageId: 11,
          processedByModerator: 5,
          caption: 'подпись',
          isUserPost: false,
          hash: 'hash',
        },
      ]);
      expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledTimes(2);
      const firstKeyboard = bot.api.editMessageReplyMarkup.mock.calls[0][2].reply_markup;
      expect(firstKeyboard.inline_keyboard[0][0].text).toBe(
        'Пост будет опубликован 👍 3   👎 1'
      );
    });

    it('одобряет пост без голосов и не добавляет текст', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity, bot } = setup();
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 0,
        dislikes: 0,
        requestChannelMessageId: 11,
      });
      userMessageModeratedPostEntity.find.mockResolvedValue([{ userId: 1, userMessageId: 50 }]);

      await (service as any).handleNextUserModeratedPost();

      expect(userModeratedPostEntity.update).toHaveBeenCalledWith({ id: 1 }, { isApproved: true });
      const keyboard = bot.api.editMessageReplyMarkup.mock.calls[0][2].reply_markup;
      expect(keyboard.inline_keyboard[0][0].text).toBe('Пост будет опубликован');
    });

    it('отклоняет пост, когда дизлайков больше', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity, bot } = setup();
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 1,
        dislikes: 5,
        requestChannelMessageId: 11,
      });
      userMessageModeratedPostEntity.find.mockResolvedValue([{ userId: 1, userMessageId: 50 }]);

      await (service as any).handleNextUserModeratedPost();

      expect(userModeratedPostEntity.update).toHaveBeenCalledWith({ id: 1 }, { isRejected: true });
      const keyboard = bot.api.editMessageReplyMarkup.mock.calls[0][2].reply_markup;
      expect(keyboard.inline_keyboard[0][0].text).toBe(
        'Пост не будет опубликован 👍 1   👎 5'
      );
    });

    it('продолжает работу, если одному пользователю не удалось обновить клавиатуру', async () => {
      const { service, userModeratedPostEntity, userMessageModeratedPostEntity, bot } = setup();
      userModeratedPostEntity.findOne.mockResolvedValue({
        id: 1,
        likes: 2,
        dislikes: 0,
        requestChannelMessageId: 11,
      });
      userMessageModeratedPostEntity.find.mockResolvedValue([
        { userId: 1, userMessageId: 50 },
        { userId: 2, userMessageId: 51 },
      ]);
      bot.api.editMessageReplyMarkup
        .mockRejectedValueOnce(new Error('blocked'))
        .mockResolvedValueOnce(undefined);

      await (service as any).handleNextUserModeratedPost();

      expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledTimes(2);
    });
  });
});
