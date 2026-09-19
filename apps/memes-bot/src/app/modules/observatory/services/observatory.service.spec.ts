jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));
jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));

import { Logger } from '@nestjs/common';
import { Menu } from '@grammyjs/menu';
import { Subject } from 'rxjs';
import { ObservatoryService } from './observatory.service';
import { ObservatoryPostMenusEnum } from '../contsants/observatory-post-menus.enum';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { UserPermissionEnum } from '../../bot/constants/user-permission.enum';

const flush = async () => {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
};

type CapturedText = { menuId: string; label: string; handler: (ctx: any) => any };

function setup() {
  const observerSubject = new Subject<any>();
  const moderatedSubject = new Subject<any>();

  const bot = {
    use: jest.fn(),
    on: jest.fn(),
    callbackQuery: jest.fn(),
    api: {
      copyMessage: jest.fn(),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
      forwardMessage: jest.fn(),
      getFile: jest.fn(),
    },
  };
  const baseConfigService = {
    userRequestMemeChannel: -200,
    memeChanelId: -300,
    botToken: 'TEST_TOKEN',
    tgEnv: 'prod',
  };
  const userService = {
    checkPermission: jest.fn(),
    repository: { findOne: jest.fn() },
  };
  const clientBaseService = { observerChannelPost$: observerSubject.asObservable() };
  const observatoryPostRepository = {
    create: jest.fn().mockImplementation((value) => value),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const postSchedulerService = { addPostToSchedule: jest.fn() };
  const settingsService = {
    cringeChannelHtmlLink: jest.fn(),
    channelHtmlLinkIfPrivate: jest.fn(),
    channelLinkUrl: jest.fn(),
  };
  const cringeManagementService = { repository: { update: jest.fn(), insert: jest.fn() } };
  const deduplicationService = {
    getPostImageHash: jest.fn(),
    checkDuplicate: jest.fn(),
    createPublishedPostHash: jest.fn().mockResolvedValue(undefined),
  };
  const userModeratedPostService = {
    buildUserModeratePost: jest.fn().mockReturnValue({ id: 'user-moderate-menu' }),
    moderateViaUsers: jest.fn(),
    userModeratedPost$: moderatedSubject.asObservable(),
  };
  const mattermostService = { sendPostWithFile: jest.fn().mockResolvedValue(undefined) };
  const trollService = { maybeRepostMeme: jest.fn().mockResolvedValue(undefined) };

  const service = new ObservatoryService(
    bot as any,
    baseConfigService as any,
    userService as any,
    clientBaseService as any,
    observatoryPostRepository as any,
    postSchedulerService as any,
    settingsService as any,
    cringeManagementService as any,
    deduplicationService as any,
    userModeratedPostService as any,
    mattermostService as any,
    trollService as any
  );

  return {
    service,
    bot,
    baseConfigService,
    userService,
    clientBaseService,
    observatoryPostRepository,
    postSchedulerService,
    settingsService,
    cringeManagementService,
    deduplicationService,
    userModeratedPostService,
    mattermostService,
    trollService,
    observerSubject,
    moderatedSubject,
  };
}

function makeCtx(overrides: any = {}) {
  return {
    channelPost: {
      photo: [{ file_id: 'photo' }],
      sender_chat: { id: -400 },
      message_id: 11,
    },
    api: {
      copyMessage: jest.fn().mockResolvedValue({ message_id: 77 }),
      editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    },
    callbackQuery: {
      message: { message_id: 11, caption: 'подпись', photo: [{ file_id: 'p' }] },
      from: { id: 5, username: 'moder' },
    },
    menu: { nav: jest.fn() },
    editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ObservatoryService', () => {
  let captured: CapturedText[] = [];

  beforeEach(() => {
    captured = [];
    jest
      .spyOn(Menu.prototype, 'text')
      .mockImplementation(function (this: any, label: any, ...middleware: any[]) {
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
  });

  function handlerFor(menuId: string, label: string) {
    const entry = captured.find((item) => item.menuId === menuId && item.label === label);
    if (!entry) throw new Error(`Не найден обработчик ${menuId}/${label}`);
    return entry.handler;
  }

  describe('onModuleInit', () => {
    it('подключает меню пользовательской модерации и строит меню обсерватории', () => {
      const { service, bot, userModeratedPostService } = setup();

      service.onModuleInit();

      expect(userModeratedPostService.buildUserModeratePost).toHaveBeenCalled();
      expect(bot.use).toHaveBeenCalledWith({ id: 'user-moderate-menu' });
      expect(bot.use).toHaveBeenCalledTimes(2);
      expect(captured.some((item) => item.menuId === ObservatoryPostMenusEnum.POST_MENU)).toBe(
        true
      );
      expect(
        captured.some((item) => item.menuId === ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION)
      ).toBe(true);
      expect(
        captured.some((item) => item.menuId === ObservatoryPostMenusEnum.USER_MODERATE_POST)
      ).toBe(true);
    });
  });

  describe('onNewObservatoryPost', () => {
    it('пересылает пост в буферный канал и сохраняет запись', async () => {
      const {
        service,
        observerSubject,
        deduplicationService,
        observatoryPostRepository,
        baseConfigService,
      } = setup();
      service.onModuleInit();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      deduplicationService.checkDuplicate.mockResolvedValue([{ distance: 0.1 }]);
      const ctx = makeCtx();

      observerSubject.next(ctx);
      await flush();

      expect(ctx.api.copyMessage).toHaveBeenCalledWith(
        baseConfigService.userRequestMemeChannel,
        ctx.channelPost.sender_chat.id,
        ctx.channelPost.message_id,
        expect.objectContaining({ disable_notification: true, caption: '' })
      );
      expect(observatoryPostRepository.create).toHaveBeenCalledWith({
        requestChannelMessageId: 77,
        sourceChatId: null,
        sourceMessageId: null,
        sourceUsername: null,
        sourceTitle: null,
        sourceUrl: null,
        originalCaption: null,
      });
      expect(observatoryPostRepository.save).toHaveBeenCalledWith({
        requestChannelMessageId: 77,
        sourceChatId: null,
        sourceMessageId: null,
        sourceUsername: null,
        sourceTitle: null,
        sourceUrl: null,
        originalCaption: null,
      });
    });

    it('добавляет служебную подпись источника из forward_origin и сохраняет поля', async () => {
      const {
        service,
        observerSubject,
        deduplicationService,
        observatoryPostRepository,
        baseConfigService,
      } = setup();
      service.onModuleInit();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      deduplicationService.checkDuplicate.mockResolvedValue([]);
      const ctx = makeCtx({
        channelPost: {
          photo: [{ file_id: 'photo' }],
          sender_chat: { id: -400 },
          message_id: 11,
          caption: 'исходный текст',
          forward_origin: {
            type: 'channel',
            message_id: 777,
            chat: { id: -1001234567890, username: 'source', title: 'Источник' },
          },
        },
      });

      observerSubject.next(ctx);
      await flush();

      expect(ctx.api.copyMessage).toHaveBeenCalledWith(
        baseConfigService.userRequestMemeChannel,
        -400,
        11,
        expect.objectContaining({
          caption: '🔎 Источник: <a href="https://t.me/source/777">Источник</a>',
          parse_mode: 'HTML',
        })
      );
      expect(observatoryPostRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceChatId: -1001234567890,
          sourceMessageId: 777,
          sourceUsername: 'source',
          sourceTitle: 'Источник',
          sourceUrl: 'https://t.me/source/777',
          originalCaption: 'исходный текст',
        })
      );
    });

    it('выкидывает пост при похожести дубля >= 0.5', async () => {
      const { service, observerSubject, deduplicationService, observatoryPostRepository, bot } =
        setup();
      service.onModuleInit();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      deduplicationService.checkDuplicate.mockResolvedValue([{ distance: 0.5 }]);

      observerSubject.next(makeCtx());
      await flush();

      expect(bot.api.copyMessage).not.toHaveBeenCalled();
      expect(observatoryPostRepository.save).not.toHaveBeenCalled();
    });

    it('пропускает пост без похожих дублей', async () => {
      const { service, observerSubject, deduplicationService } = setup();
      service.onModuleInit();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      deduplicationService.checkDuplicate.mockResolvedValue([{ distance: 0.2 }, { distance: 0.1 }]);
      const ctx = makeCtx();

      observerSubject.next(ctx);
      await flush();

      expect(ctx.api.copyMessage).toHaveBeenCalled();
    });

    it('безопасно разбирает контекст без канала', async () => {
      const { service, observerSubject, deduplicationService } = setup();
      service.onModuleInit();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      deduplicationService.checkDuplicate.mockResolvedValue([{ distance: 0.9 }]);

      observerSubject.next({});
      observerSubject.next(undefined);
      await flush();

      expect(deduplicationService.getPostImageHash).toHaveBeenCalledWith(undefined);
      expect(deduplicationService.checkDuplicate).toHaveBeenCalledTimes(2);
    });
  });

  describe('onNewUserModeratedPost', () => {
    it('публикует пост с режимом из контекста модерации', async () => {
      const { service, moderatedSubject } = setup();
      service.onModuleInit();
      const publishSpy = jest
        .spyOn(service as any, 'publishWithContext')
        .mockResolvedValue(undefined);
      const ctx = { mode: PublicationModesEnum.NOW_SILENT };

      moderatedSubject.next(ctx);
      await flush();

      expect(publishSpy).toHaveBeenCalledWith(PublicationModesEnum.NOW_SILENT, ctx);
    });
  });

  describe('меню обсерватории', () => {
    it('навигация по кнопкам верхнего меню учитывает права', async () => {
      const { service, userService } = setup();
      service.onModuleInit();
      const ctx = makeCtx();

      userService.checkPermission.mockReturnValue(false);
      await handlerFor(ObservatoryPostMenusEnum.POST_MENU, 'Опубликовать')(ctx);
      await handlerFor(ObservatoryPostMenusEnum.POST_MENU, 'На модерацию пользователям')(ctx);
      expect(ctx.menu.nav).not.toHaveBeenCalled();

      userService.checkPermission.mockReturnValue(true);
      await handlerFor(ObservatoryPostMenusEnum.POST_MENU, 'Опубликовать')(ctx);
      expect(ctx.menu.nav).toHaveBeenCalledWith(
        ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION
      );
      await handlerFor(ObservatoryPostMenusEnum.POST_MENU, 'На модерацию пользователям')(ctx);
      expect(ctx.menu.nav).toHaveBeenCalledWith(ObservatoryPostMenusEnum.USER_MODERATE_POST);
    });

    it('кнопка «Отклонить» вызывает отклонение только с правами', async () => {
      const { service, userService } = setup();
      service.onModuleInit();
      const rejectSpy = jest.spyOn(service as any, 'rejectObserverPost').mockResolvedValue(undefined);
      const ctx = makeCtx();

      userService.checkPermission.mockReturnValue(false);
      await handlerFor(ObservatoryPostMenusEnum.POST_MENU, 'Отклонить')(ctx);
      expect(rejectSpy).not.toHaveBeenCalled();

      userService.checkPermission.mockReturnValue(true);
      await handlerFor(ObservatoryPostMenusEnum.POST_MENU, 'Отклонить')(ctx);
      expect(rejectSpy).toHaveBeenCalledWith(ctx);
    });

    it('кнопки публикации вызывают publishPost с разными режимами', async () => {
      const { service } = setup();
      service.onModuleInit();
      const publishSpy = jest.spyOn(service as any, 'publishPost').mockResolvedValue(undefined);
      const backSpy = jest.fn();

      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Кринж')(makeCtx());
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Сейчас')(makeCtx());
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Ближайший слот')(
        makeCtx()
      );
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Ночью')(makeCtx());
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Утром')(makeCtx());
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Днем')(makeCtx());
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Вечером')(makeCtx());
      await handlerFor(ObservatoryPostMenusEnum.OBSERVATORY_PUBLICATION, 'Назад')({
        menu: { nav: backSpy },
      });

      expect(publishSpy.mock.calls.map((call) => call[1])).toEqual([
        PublicationModesEnum.NIGHT_CRINGE,
        PublicationModesEnum.NOW_SILENT,
        PublicationModesEnum.NEXT_INTERVAL,
        PublicationModesEnum.NEXT_NIGHT,
        PublicationModesEnum.NEXT_MORNING,
        PublicationModesEnum.NEXT_MIDDAY,
        PublicationModesEnum.NEXT_EVENING,
      ]);
      expect(backSpy).toHaveBeenCalledWith(ObservatoryPostMenusEnum.POST_MENU);
    });

    it('кнопки пользовательской модерации вызывают moderateViaUsers и publishPost', async () => {
      const { service } = setup();
      service.onModuleInit();
      const moderateSpy = jest
        .spyOn(service as any, 'moderateViaUsers')
        .mockResolvedValue(undefined);
      const publishSpy = jest.spyOn(service as any, 'publishPost').mockResolvedValue(undefined);
      const backSpy = jest.fn();

      const menu = ObservatoryPostMenusEnum.USER_MODERATE_POST;
      await handlerFor(menu, 'Сейчас')(makeCtx());
      await handlerFor(menu, 'Ближайший слот')(makeCtx());
      await handlerFor(menu, 'Ночью')(makeCtx());
      await handlerFor(menu, 'Утром')(makeCtx());
      await handlerFor(menu, 'Днем')(makeCtx());
      await handlerFor(menu, 'Вечером')(makeCtx());
      await handlerFor(menu, 'Назад')({ menu: { nav: backSpy } });

      expect(moderateSpy.mock.calls.map((call) => call[1])).toEqual([
        PublicationModesEnum.NOW_SILENT,
        PublicationModesEnum.NEXT_NIGHT,
        PublicationModesEnum.NEXT_MORNING,
        PublicationModesEnum.NEXT_MIDDAY,
        PublicationModesEnum.NEXT_EVENING,
      ]);
      expect(publishSpy).toHaveBeenCalledWith(expect.anything(), PublicationModesEnum.NEXT_INTERVAL);
      expect(backSpy).toHaveBeenCalledWith(ObservatoryPostMenusEnum.POST_MENU);
    });
  });

  describe('publishPost', () => {
    it('не публикует без права на публикацию', async () => {
      const { service, userService } = setup();
      userService.checkPermission.mockReturnValue(false);
      const publishSpy = jest.spyOn(service as any, 'publishWithContext');

      await (service as any).publishPost(makeCtx(), PublicationModesEnum.NOW_SILENT);

      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('собирает контекст публикации и делегирует в publishWithContext', async () => {
      const { service, userService, deduplicationService } = setup();
      userService.checkPermission.mockReturnValue(true);
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      const publishSpy = jest
        .spyOn(service as any, 'publishWithContext')
        .mockResolvedValue(undefined);
      const ctx = makeCtx();

      await (service as any).publishPost(ctx, PublicationModesEnum.NEXT_NIGHT);

      expect(deduplicationService.getPostImageHash).toHaveBeenCalledWith(
        ctx.callbackQuery.message.photo
      );
      expect(publishSpy).toHaveBeenCalledWith(PublicationModesEnum.NEXT_NIGHT, {
        mode: PublicationModesEnum.NEXT_NIGHT,
        requestChannelMessageId: 11,
        processedByModerator: 5,
        isUserPost: false,
        hash: 'hash',
      });
    });

    it('падает на некорректном callbackQuery без message', async () => {
      const { service, userService, deduplicationService } = setup();
      userService.checkPermission.mockReturnValue(true);
      deduplicationService.getPostImageHash.mockResolvedValue('hash');

      await expect(
        (service as any).publishPost(undefined, PublicationModesEnum.NOW_SILENT)
      ).rejects.toThrow();
      await expect(
        (service as any).publishPost({}, PublicationModesEnum.NOW_SILENT)
      ).rejects.toThrow();
      await expect(
        (service as any).publishPost({ callbackQuery: {} }, PublicationModesEnum.NOW_SILENT)
      ).rejects.toThrow();
    });
  });

  describe('publishWithContext', () => {
    it('маршрутизирует режимы по нужным обработчикам', () => {
      const { service } = setup();
      const now = jest.spyOn(service as any, 'onPublishNow').mockResolvedValue(undefined);
      const scheduled = jest.spyOn(service as any, 'publishScheduled').mockResolvedValue(undefined);
      const night = jest
        .spyOn(service as any, 'publishNightCringeScheduled')
        .mockResolvedValue(undefined);
      const context = { requestChannelMessageId: 1 } as any;

      (service as any).publishWithContext(PublicationModesEnum.NOW_SILENT, context);
      for (const mode of [
        PublicationModesEnum.NEXT_MORNING,
        PublicationModesEnum.NEXT_MIDDAY,
        PublicationModesEnum.NEXT_EVENING,
        PublicationModesEnum.NEXT_INTERVAL,
        PublicationModesEnum.NEXT_NIGHT,
      ]) {
        (service as any).publishWithContext(mode, context);
      }
      (service as any).publishWithContext(PublicationModesEnum.NIGHT_CRINGE, context);

      expect(now).toHaveBeenCalledTimes(1);
      expect(scheduled).toHaveBeenCalledTimes(5);
      expect(night).toHaveBeenCalledTimes(1);
    });
  });

  describe('onPublishNow', () => {
    it('публикует сейчас с обычной ссылкой на канал', async () => {
      const {
        service,
        bot,
        baseConfigService,
        userService,
        settingsService,
        deduplicationService,
        observatoryPostRepository,
        trollService,
      } = setup();
      bot.api.copyMessage.mockResolvedValue({ message_id: 55 });
      settingsService.channelHtmlLinkIfPrivate.mockResolvedValue('<a>канал</a>');
      settingsService.channelLinkUrl.mockResolvedValue('https://channel');
      userService.repository.findOne.mockResolvedValue({ username: 'moder' });

      await service.onPublishNow({
        mode: PublicationModesEnum.NOW_SILENT,
        requestChannelMessageId: 11,
        processedByModerator: 5,
        caption: 'текст',
        isUserPost: false,
        hash: 'hash',
      });

      expect(settingsService.channelHtmlLinkIfPrivate).toHaveBeenCalled();
      expect(bot.api.copyMessage).toHaveBeenCalledWith(
        baseConfigService.memeChanelId,
        baseConfigService.userRequestMemeChannel,
        11,
        {
          caption: 'текст\n<a>канал</a>',
          parse_mode: 'HTML',
          disable_notification: true,
        }
      );
      expect(observatoryPostRepository.update).toHaveBeenCalledWith(
        { requestChannelMessageId: 11 },
        {
          publishedMessageId: 55,
          isApproved: true,
          processedByModerator: { id: 5 },
        }
      );
      expect(deduplicationService.createPublishedPostHash).toHaveBeenCalledWith('hash', 55);
      expect(trollService.maybeRepostMeme).toHaveBeenCalledWith(baseConfigService.memeChanelId, 55);
    });

    it('для ночного кринжа берёт ссылку кринж-канала и обновляет его репозиторий', async () => {
      const {
        service,
        bot,
        settingsService,
        cringeManagementService,
        userService,
        observatoryPostRepository,
      } = setup();
      bot.api.copyMessage.mockResolvedValue({ message_id: 66 });
      settingsService.cringeChannelHtmlLink.mockResolvedValue('<b>кринж</b>');
      settingsService.channelLinkUrl.mockResolvedValue('https://channel');
      userService.repository.findOne.mockResolvedValue({ username: 'moder' });

      await service.onPublishNow({
        mode: PublicationModesEnum.NIGHT_CRINGE,
        requestChannelMessageId: 11,
        processedByModerator: 5,
        isUserPost: false,
        hash: 'hash',
      });

      expect(settingsService.cringeChannelHtmlLink).toHaveBeenCalled();
      expect(bot.api.copyMessage).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        11,
        expect.objectContaining({ caption: '<b>кринж</b>' })
      );
      expect(cringeManagementService.repository.update).toHaveBeenCalledWith(
        { requestChannelMessageId: 11 },
        { memeChannelMessageId: 66 }
      );

      expect(observatoryPostRepository.update).toHaveBeenCalledWith(
        { requestChannelMessageId: 11 },
        expect.objectContaining({ publishedMessageId: 66, isApproved: true })
      );
    });
  });

  describe('publishScheduled', () => {
    it('не обновляет клавиатуру, если дата не получена', async () => {
      const { service, postSchedulerService, bot, userService } = setup();
      postSchedulerService.addPostToSchedule.mockResolvedValue(undefined);

      await (service as any).publishScheduled({
        mode: PublicationModesEnum.NEXT_NIGHT,
        requestChannelMessageId: 11,
        processedByModerator: 5,
      });

      expect(bot.api.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(userService.repository.findOne).not.toHaveBeenCalled();
    });

    it('ставит пост в расписание и показывает дату с ником модератора', async () => {
      const { service, postSchedulerService, bot, userService, baseConfigService } = setup();
      const publishDate = new Date('2026-09-18T18:30:00.000Z');
      postSchedulerService.addPostToSchedule.mockResolvedValue(publishDate);
      userService.repository.findOne.mockResolvedValue({ username: 'moder' });

      await (service as any).publishScheduled({
        mode: PublicationModesEnum.NEXT_EVENING,
        requestChannelMessageId: 11,
        processedByModerator: 5,
      });

      expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledWith(
        baseConfigService.userRequestMemeChannel,
        11,
        { reply_markup: expect.anything() }
      );
      const keyboard = bot.api.editMessageReplyMarkup.mock.calls[0][2].reply_markup;
      const button = keyboard.inline_keyboard[0][0];
      expect(button.text).toContain('moder');
      expect(button.text).toContain('⏰');
    });
  });

  describe('publishNightCringeScheduled', () => {
    it('вставляет запись в кринж-репозиторий и планирует публикацию', async () => {
      const { service, cringeManagementService } = setup();
      cringeManagementService.repository.insert.mockResolvedValue(undefined);
      const scheduledSpy = jest
        .spyOn(service as any, 'publishScheduled')
        .mockResolvedValue(undefined);
      const context = {
        mode: PublicationModesEnum.NIGHT_CRINGE,
        requestChannelMessageId: 11,
        isUserPost: false,
      } as any;

      await (service as any).publishNightCringeScheduled(context);

      expect(cringeManagementService.repository.insert).toHaveBeenCalledWith({
        requestChannelMessageId: 11,
        isUserPost: false,
      });
      expect(scheduledSpy).toHaveBeenCalledWith(context);
    });
  });

  describe('rejectObserverPost', () => {
    it('помечает пост отклонённым и меняет клавиатуру', async () => {
      const { service, observatoryPostRepository } = setup();
      const ctx = makeCtx();

      await (service as any).rejectObserverPost(ctx);

      expect(observatoryPostRepository.update).toHaveBeenCalledWith(
        { requestChannelMessageId: 11 },
        { isApproved: false, processedByModerator: { id: 5 } }
      );
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: expect.anything(),
      });
    });
  });

  describe('waitDeleteObserverPost', () => {
    it('удаляет сообщение только при наличии права', async () => {
      const { service, bot, userService } = setup();
      const callbacks: Record<string, any> = {};
      bot.callbackQuery.mockImplementation((trigger: string, cb: any) => {
        callbacks[trigger] = cb;
      });
      (service as any).waitDeleteObserverPost();
      const handler = callbacks[ObservatoryPostMenusEnum.DELETE_OBSERVER_POST];

      const ctx = makeCtx();
      userService.checkPermission.mockReturnValue(false);
      await handler(ctx);
      expect(ctx.deleteMessage).not.toHaveBeenCalled();

      userService.checkPermission.mockReturnValue(true);
      await handler(ctx);
      expect(ctx.deleteMessage).toHaveBeenCalled();
    });
  });

  describe('moderateViaUsers', () => {
    it('запускает пользовательскую модерацию и показывает счётчик', async () => {
      const {
        service,
        userModeratedPostService,
        deduplicationService,
        bot,
        baseConfigService,
      } = setup();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');
      userModeratedPostService.moderateViaUsers.mockResolvedValue(7);
      const ctx = makeCtx();

      await (service as any).moderateViaUsers(ctx, PublicationModesEnum.NOW_SILENT);

      expect(userModeratedPostService.moderateViaUsers).toHaveBeenCalledWith(ctx, {
        mode: PublicationModesEnum.NOW_SILENT,
        requestChannelMessageId: 11,
        processedByModerator: 5,
        isUserPost: false,
        hash: 'hash',
      });
      const keyboard = bot.api.editMessageReplyMarkup.mock.calls[0][2].reply_markup;
      expect(keyboard.inline_keyboard[0][0].text).toBe('👷 Модерируют пользователи (7)');
      expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledWith(
        baseConfigService.userRequestMemeChannel,
        11,
        { reply_markup: expect.anything() }
      );
    });

    it('падает на некорректном callbackQuery без message', async () => {
      const { service, deduplicationService } = setup();
      deduplicationService.getPostImageHash.mockResolvedValue('hash');

      await expect(
        (service as any).moderateViaUsers(undefined, PublicationModesEnum.NOW_SILENT)
      ).rejects.toThrow();
      await expect(
        (service as any).moderateViaUsers({}, PublicationModesEnum.NOW_SILENT)
      ).rejects.toThrow();
      await expect(
        (service as any).moderateViaUsers({ callbackQuery: {} }, PublicationModesEnum.NOW_SILENT)
      ).rejects.toThrow();
    });
  });

  describe('getTelegramFileUrl', () => {
    it('возвращает ссылку на фото без test-префикса', async () => {
      const { service, bot, baseConfigService } = setup();
      bot.api.forwardMessage.mockResolvedValue({
        photo: [{ file_id: 'small' }, { file_id: 'big' }],
      });
      bot.api.getFile.mockResolvedValue({ file_path: 'photos/file.jpg' });

      await expect((service as any).getTelegramFileUrl(11)).resolves.toBe(
        `https://api.telegram.org/file/bot${baseConfigService.botToken}/photos/file.jpg`
      );
      expect(bot.api.getFile).toHaveBeenCalledWith('big');
    });

    it('поддерживает video, document и animation', async () => {
      const { service, bot } = setup();
      bot.api.getFile.mockResolvedValue({ file_path: 'f' });

      bot.api.forwardMessage.mockResolvedValue({ video: { file_id: 'v' } });
      await (service as any).getTelegramFileUrl(1);
      expect(bot.api.getFile).toHaveBeenLastCalledWith('v');

      bot.api.forwardMessage.mockResolvedValue({ document: { file_id: 'd' } });
      await (service as any).getTelegramFileUrl(1);
      expect(bot.api.getFile).toHaveBeenLastCalledWith('d');

      bot.api.forwardMessage.mockResolvedValue({ animation: { file_id: 'a' } });
      await (service as any).getTelegramFileUrl(1);
      expect(bot.api.getFile).toHaveBeenLastCalledWith('a');
    });

    it('возвращает undefined, если файла нет', async () => {
      const { service, bot } = setup();
      bot.api.forwardMessage.mockResolvedValue({});
      await expect((service as any).getTelegramFileUrl(1)).resolves.toBeUndefined();

      bot.api.forwardMessage.mockResolvedValue({ photo: [{ file_id: 'p' }] });
      bot.api.getFile.mockResolvedValue({});
      await expect((service as any).getTelegramFileUrl(1)).resolves.toBeUndefined();

      bot.api.getFile.mockResolvedValue(undefined);
      await expect((service as any).getTelegramFileUrl(1)).resolves.toBeUndefined();
    });

    it('добавляет test-сегмент в ссылку при TG_ENV=test', async () => {
      const { service, bot, baseConfigService } = setup();
      (baseConfigService as any).tgEnv = 'test';
      bot.api.forwardMessage.mockResolvedValue({ photo: [{ file_id: 'p' }] });
      bot.api.getFile.mockResolvedValue({ file_path: 'file.jpg' });

      await expect((service as any).getTelegramFileUrl(1)).resolves.toBe(
        `https://api.telegram.org/file/bot${baseConfigService.botToken}/test/file.jpg`
      );
    });

    it('логирует и возвращает undefined при ошибке', async () => {
      const { service, bot } = setup();
      const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      bot.api.forwardMessage.mockRejectedValue(new Error('fail'));

      await expect((service as any).getTelegramFileUrl(1)).resolves.toBeUndefined();
      expect(loggerSpy).toHaveBeenCalled();
    });
  });

  describe('sendToMattermost', () => {
    it('отправляет пост с файлом', async () => {
      const { service, mattermostService } = setup();
      jest
        .spyOn(service as any, 'getTelegramFileUrl')
        .mockResolvedValue('https://file');

      await (service as any).sendToMattermost(11, 'подпись');

      expect(mattermostService.sendPostWithFile).toHaveBeenCalledWith({
        message: 'подпись',
        fileUrl: 'https://file',
        fileName: 'observatory_meme_11',
      });
    });

    it('логирует ошибку, но не падает', async () => {
      const { service, mattermostService } = setup();
      const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(service as any, 'getTelegramFileUrl')
        .mockRejectedValue(new Error('no file'));

      await expect((service as any).sendToMattermost(11, 'x')).resolves.toBeUndefined();
      expect(loggerSpy).toHaveBeenCalledWith('Failed to send to Mattermost:', expect.any(Error));
    });
  });
});
