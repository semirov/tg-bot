import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { UserPermissionEnum } from '../../bot/constants/user-permission.enum';
import { ObservedStatus } from '../constants/parser.constants';
import { ParserModerationService } from './parser-moderation.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const makeCtx = (overrides: Record<string, unknown> = {}): any => ({
  callbackQuery: {
    message: { message_id: 7777, chat: { id: -1004444444444 } },
    from: { id: 50, username: 'moderator' },
  },
  answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  config: { isOwner: true, user: { isModerator: true } },
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): any => ({
  id: 10,
  sourceChatId: '-1008888888888',
  requestChannelMessageId: 7777,
  status: ObservedStatus.DELIVERED,
  imageHash: 'abcd1234',
  perceptualHash: 'efgh5678efgh5678',
  ...overrides,
});

const makeBot = (): any => ({
  api: {
    copyMessage: jest.fn().mockResolvedValue({ message_id: 8888 }),
    sendMessage: jest.fn().mockResolvedValue(undefined),
  },
  callbackQuery: jest.fn(),
});

const makeObservedRepo = (): any => ({
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeUserService = (allowed = true): any => ({
  checkPermission: jest.fn().mockReturnValue(allowed),
});

const makeScheduler = (): any => ({
  addPostToSchedule: jest.fn().mockResolvedValue(new Date('2026-09-20T03:00:00Z')),
  formatToMsk: (date: Date) => date,
});

const makeCringe = (): any => ({
  repository: { insert: jest.fn().mockResolvedValue(undefined) },
});

const makeDedup = (): any => ({
  createPublishedPostHash: jest.fn().mockResolvedValue(undefined),
});

const makeConfig = (): any => ({
  memeChanelId: -1001111111111,
  userRequestMemeChannel: -1004444444444,
  ownerId: 1,
});

const makeDelivery = (): any => ({
  buildKeyboard: jest.fn().mockReturnValue({ keyboard: 'main' }),
  buildExcludeConfirmKeyboard: jest.fn().mockReturnValue({ keyboard: 'confirm' }),
});

const makeRegistry = (): any => ({
  repository: {
    findOne: jest.fn().mockResolvedValue({ id: 5, rejectedTotal: 0, chatId: '-1008888888888' }),
    save: jest.fn().mockResolvedValue(undefined),
  },
  markSourceTaken: jest.fn().mockResolvedValue(undefined),
  markSourceIgnored: jest.fn().mockResolvedValue(undefined),
  excludeSource: jest.fn().mockResolvedValue({ id: 5, excluded: true }),
});

const setup = (overrides: { candidate?: Record<string, unknown>; allowed?: boolean } = {}) => {
  const observedRepo = makeObservedRepo();
  observedRepo.findOne.mockResolvedValue(candidate(overrides.candidate ?? {}));
  const scheduler = makeScheduler();
  const cringe = makeCringe();
  const registry = makeRegistry();
  const delivery = makeDelivery();
  const userService = makeUserService(overrides.allowed ?? true);
  const service = new ParserModerationService(
    makeBot(),
    observedRepo,
    delivery as never,
    userService,
    scheduler,
    cringe,
    makeDedup(),
    { repository: { findOne: jest.fn() } } as never,
    makeConfig(),
    registry as never
  );
  return {
    service,
    observedRepo,
    scheduler,
    cringe,
    registry,
    delivery,
    userService,
    bot: (service as never as { bot: any }).bot,
    dedup: (service as never as { deduplication: any }).deduplication,
  };
};

describe('ParserModerationService', () => {
  it('registerCallbacks регистрирует обработчик карточек парсера', () => {
    const { service, bot } = setup();
    service.registerCallbacks();

    expect(bot.callbackQuery).toHaveBeenCalledTimes(1);
    const [pattern] = bot.callbackQuery.mock.calls[0];
    expect(pattern).toBeInstanceOf(RegExp);
    expect(String(pattern)).toContain('prs:');
    expect(String(pattern)).toContain('excl');
  });

  it('зарегистрированный обработчик вызывает handleAction', async () => {
    const { service, bot, observedRepo } = setup();
    service.registerCallbacks();
    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = makeCtx({ match: ['prs:now:10', 'now', '10'] });

    await handler(ctx);

    expect(observedRepo.findOne).toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Опубликовано');
  });

  it('зарегистрированный обработчик без match не роняет', async () => {
    const { service, bot } = setup();
    service.registerCallbacks();
    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = makeCtx({ match: undefined });

    await expect(handler(ctx)).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('без callbackQuery карточка считается устаревшей', async () => {
    const { service } = setup();
    const ctx = makeCtx({ callbackQuery: undefined });

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Пост устарел');
  });

  it('кандидат не найден → ответ', async () => {
    const { service, observedRepo } = setup();
    observedRepo.findOne.mockResolvedValue(null);
    const ctx = makeCtx();

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Кандидат не найден');
  });

  it('карточка без message_id → ответ', async () => {
    const { service } = setup({ candidate: { requestChannelMessageId: null } });
    const ctx = makeCtx();

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Кандидат не найден');
  });

  it('чужая карточка (message_id не совпал) → отказ', async () => {
    const { service } = setup({ candidate: { requestChannelMessageId: 9999 } });
    const ctx = makeCtx();

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Пост устарел');
  });

  it('нет прав → обработчик не срабатывает', async () => {
    const { service, observedRepo } = setup({ allowed: false });
    const ctx = makeCtx();

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Нет прав');
    expect(observedRepo.save).not.toHaveBeenCalled();
  });

  it('уже обработанная карточка → «Уже обработано»', async () => {
    const { service } = setup({ candidate: { status: ObservedStatus.QUEUED } });
    const ctx = makeCtx();

    await service.handleAction(ctx, 'now', 10);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Уже обработано');
  });

  describe('исключение источника', () => {
    it('excl: владелец получает подтверждение', async () => {
      const { service, delivery } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'excl', 10);

      expect(delivery.buildExcludeConfirmKeyboard).toHaveBeenCalledWith(10);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Исключить источник?');
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
        reply_markup: delivery.buildExcludeConfirmKeyboard(),
      });
    });

    it('exclno: возвращает обычную клавиатуру', async () => {
      const { service, delivery } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'exclno', 10);

      expect(delivery.buildKeyboard).toHaveBeenCalledWith(10);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отменено');
    });

    it('exclok: исключает источник', async () => {
      const { service, registry } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'exclok', 10);

      expect(registry.excludeSource).toHaveBeenCalledWith(5);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Источник исключён');
    });

    it('exclok: источник не найден', async () => {
      const { service, registry } = setup();
      registry.repository.findOne.mockResolvedValue(null);
      const ctx = makeCtx();

      await service.excludeSourceOf(ctx, candidate());

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Источник не найден');
    });

    it('excl: без прав не подтверждает', async () => {
      const { service, delivery } = setup({ allowed: false });
      const ctx = makeCtx();

      await service.handleAction(ctx, 'excl', 10);

      expect(delivery.buildExcludeConfirmKeyboard).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Нет прав');
    });

    it('exclok: без прав не исключает', async () => {
      const { service, registry } = setup({ allowed: false });
      const ctx = makeCtx();

      await service.handleAction(ctx, 'exclok', 10);

      expect(registry.excludeSource).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Нет прав');
    });
  });

  describe('publish now', () => {
    it('копия в основной канал, статус PUBLISHED, хеш в дедуп', async () => {
      const { service, observedRepo, dedup, registry } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'now', 10);

      expect((service as never as { bot: any }).bot.api.copyMessage).toHaveBeenCalledWith(
        -1001111111111,
        -1004444444444,
        7777,
        expect.objectContaining({ parse_mode: 'HTML', caption: expect.stringContaining('t.me/c/') })
      );
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.PUBLISHED, publishedMessageId: 8888 })
      );
      expect(dedup.createPublishedPostHash).toHaveBeenCalledWith('abcd1234', 8888);
      expect(registry.markSourceTaken).toHaveBeenCalledWith('-1008888888888');
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Опубликовано');
    });

    it('без imageHash берётся perceptualHash', async () => {
      const { service, dedup } = setup({ candidate: { imageHash: null } });
      const ctx = makeCtx();

      await service.handleAction(ctx, 'now', 10);

      expect(dedup.createPublishedPostHash).toHaveBeenCalledWith('efgh5678efgh5678', 8888);
    });

    it('без обоих хешей в дедуп не пишем', async () => {
      const { service, dedup } = setup({ candidate: { imageHash: null, perceptualHash: null } });
      const ctx = makeCtx();

      await service.handleAction(ctx, 'now', 10);

      expect(dedup.createPublishedPostHash).not.toHaveBeenCalled();
    });

    it('ошибка публикации → сообщение об ошибке', async () => {
      const { service } = setup();
      const ctx = makeCtx();
      ((service as never as { bot: any }).bot.api.copyMessage as jest.Mock).mockRejectedValue(
        new Error('boom')
      );

      await service.handleAction(ctx, 'now', 10);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Ошибка публикации');
    });
  });

  describe('queue', () => {
    it('планирование в общий интервал, статус QUEUED', async () => {
      const { service, observedRepo, scheduler, dedup, registry } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'q', 10);

      expect(scheduler.addPostToSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ mode: PublicationModesEnum.NEXT_INTERVAL, isUserPost: false })
      );
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.QUEUED })
      );
      expect(dedup.createPublishedPostHash).toHaveBeenCalled();
      expect(registry.markSourceTaken).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
    });

    it('уже запланирован → ответ без изменений', async () => {
      const { service, observedRepo, scheduler } = setup();
      scheduler.addPostToSchedule.mockResolvedValue(undefined);
      const ctx = makeCtx();

      await service.handleAction(ctx, 'q', 10);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Уже запланирован');
      expect(observedRepo.save).not.toHaveBeenCalled();
    });

    it('queue без from использует ownerId', async () => {
      const { service, scheduler } = setup();
      const ctx = makeCtx({ callbackQuery: { message: { message_id: 7777 } } });

      await service.queue(ctx, candidate(), PublicationModesEnum.NEXT_INTERVAL, '📋');

      expect(scheduler.addPostToSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ processedByModerator: 1 })
      );
    });
  });

  describe('night cringe', () => {
    it('NIGHT_CRINGE слот + запись в cringe-management', async () => {
      const { service, cringe, scheduler } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'night', 10);

      expect(scheduler.addPostToSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ mode: PublicationModesEnum.NIGHT_CRINGE })
      );
      expect(cringe.repository.insert).toHaveBeenCalledWith({
        requestChannelMessageId: 7777,
        isUserPost: false,
      });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('В ночной кринж');
    });

    it('не планируем второй раз → cringe-запись не создаётся', async () => {
      const { service, cringe, scheduler } = setup();
      scheduler.addPostToSchedule.mockResolvedValue(undefined);
      const ctx = makeCtx();

      await service.handleAction(ctx, 'night', 10);

      expect(cringe.repository.insert).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Уже запланирован');
    });

    it('night без from использует ownerId', async () => {
      const { service, scheduler } = setup();
      const ctx = makeCtx({ callbackQuery: { message: { message_id: 7777 } } });

      await service.publishNight(ctx, candidate());

      expect(scheduler.addPostToSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ processedByModerator: 1 })
      );
    });
  });

  describe('reject', () => {
    it('статус REJECTED, счётчик источника и мягкий игнор', async () => {
      const { service, observedRepo, registry } = setup();
      const sourceObj = { id: 5, rejectedTotal: 0, chatId: '-1008888888888' };
      registry.repository.findOne.mockResolvedValue(sourceObj);
      const ctx = makeCtx();

      await service.handleAction(ctx, 'rej', 10);

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'moderator-rejected' })
      );
      expect(sourceObj.rejectedTotal).toBe(1);
      expect(registry.repository.save).toHaveBeenCalledWith(sourceObj);
      expect(registry.markSourceIgnored).toHaveBeenCalledWith('-1008888888888');
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отклонено');
    });

    it('без источника всё равно отклоняет', async () => {
      const { service, registry } = setup();
      registry.repository.findOne.mockResolvedValue(null);
      const ctx = makeCtx();

      await service.handleAction(ctx, 'rej', 10);

      expect(registry.markSourceIgnored).toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отклонено');
    });

    it('reject без from логирует как moderator', async () => {
      const { service, registry } = setup();
      const ctx = makeCtx({ callbackQuery: { message: { message_id: 7777 } } });

      await service.reject(ctx, candidate());

      expect(registry.markSourceIgnored).toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отклонено');
    });

    it('rej требует прав модератора', async () => {
      const { service, userService } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'rej', 10);

      expect(userService.checkPermission).toHaveBeenCalledWith(ctx, UserPermissionEnum.IS_BASE_MODERATOR);
    });
  });

  describe('publishCaption', () => {
    it('без источника пусто; с источником — внутренняя ссылка', () => {
      const { service } = setup();
      const cast = service as never as { publishCaption: (c: unknown) => string };
      expect(cast.publishCaption(candidate({ sourceChatId: null }))).toBe('');
      expect(cast.publishCaption(candidate({ sourceChatId: '-1000000000123' }))).toContain('t.me/c/123');
    });
  });

  it('ошибка редактирования клавиатуры не роняет обработку', async () => {
    const { service } = setup();
    const ctx = makeCtx();
    ctx.editMessageReplyMarkup.mockRejectedValue(new Error('message is not modified'));

    await expect(service.handleAction(ctx, 'q', 10)).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Запланировано');
  });
});
