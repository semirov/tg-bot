import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { ObservedStatus } from '../constants/parser.constants';
import { ParserModerationService } from './parser-moderation.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const NOW = new Date('2026-09-19T12:00:00Z');

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

const setup = (overrides: { candidate?: Record<string, unknown>; allowed?: boolean } = {}) => {
  const observedRepo = makeObservedRepo();
  observedRepo.findOne.mockResolvedValue(candidate(overrides.candidate ?? {}));
  const scheduler = makeScheduler();
  const cringe = makeCringe();
  const discovery = {
    approve: jest.fn().mockResolvedValue({ id: 1, verdict: 'approved' }),
    reject: jest.fn().mockResolvedValue({ id: 1, verdict: 'rejected' }),
  };
  const service = new ParserModerationService(
    makeBot(),
    observedRepo,
    { buildCandidateKeyboard: jest.fn() } as never,
    makeUserService(overrides.allowed ?? true),
    scheduler,
    cringe,
    makeDedup(),
    discovery as never,
    makeConfig(),
    {
      repository: { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() },
    } as never
  );
  return {
    service,
    observedRepo,
    scheduler,
    cringe,
    discovery,
    dedup: (service as never as { deduplication: any }).deduplication,
  };
};

describe('ParserModerationService', () => {
  it('registerCallbacks регистрирует оба префикса', async () => {
    const bot = makeBot();
    const observedRepo = makeObservedRepo();
    const service = new ParserModerationService(
      bot,
      observedRepo,
      { buildCandidateKeyboard: jest.fn() } as never,
      makeUserService(),
      makeScheduler(),
      makeCringe(),
      makeDedup(),
      { approve: jest.fn(), reject: jest.fn() } as never,
      makeConfig(),
      { repository: { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() } } as never
    );
    service.registerCallbacks();

    expect(bot.callbackQuery).toHaveBeenCalledTimes(2);

    // Вызываем зарегистрированный обработчик карточки
    const [pattern, handler] = bot.callbackQuery.mock.calls[0];
    expect(pattern).toBeInstanceOf(RegExp);
    expect(String(pattern)).toContain('prs:');

    const ctx = makeCtx();
    const observedRepo2 = observedRepo;
    await handler(ctx);
    // кандидат найден и action передан: now → публикация
    expect(observedRepo2.findOne).toHaveBeenCalled();
  });

  it('кандидат не найден → ответ', async () => {
    const { service } = setup();
    (service as never as { observedRepository: any }).observedRepository.findOne.mockResolvedValue(null);
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

    expect(observedRepo.save).not.toHaveBeenCalled();
  });

  describe('publish now', () => {
    it('копия в основной канал, статус PUBLISHED, хеш в дедуп', async () => {
      const { service, observedRepo, dedup } = setup();
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
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Опубликовано');
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
      const { service, observedRepo, scheduler } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'q', 10);

      expect(scheduler.addPostToSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ mode: PublicationModesEnum.NEXT_INTERVAL, isUserPost: false })
      );
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.QUEUED })
      );
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
    });

    it('не планируем второй раз → cringe-запись не создаётся', async () => {
      const { service, cringe, scheduler } = setup();
      scheduler.addPostToSchedule.mockResolvedValue(undefined);
      const ctx = makeCtx();

      await service.handleAction(ctx, 'night', 10);

      expect(cringe.repository.insert).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('статус REJECTED + клавиатура-заглушка', async () => {
      const { service, observedRepo } = setup();
      const ctx = makeCtx();

      await service.handleAction(ctx, 'rej', 10);

      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'moderator-rejected' })
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отклонено');
    });
  });

  describe('handleCandidate', () => {
    it('не владелец → отказ', async () => {
      const { service } = setup();
      const ctx = makeCtx({ config: { isOwner: false } });

      await service.handleCandidate(ctx, 'wo', 1);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
    });

    it('reject-кандидат работает', async () => {
      const { service } = setup();
      const discovery = (service as never as { discovery: any }).discovery;
      const ctx = makeCtx();

      await service.handleCandidate(ctx, 'rj', 1);

      expect(discovery.reject).toHaveBeenCalledWith(1);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отклонён');
    });

    it('approve-кандидат web_only', async () => {
      const { service } = setup();
      const discovery = (service as never as { discovery: any }).discovery;
      const ctx = makeCtx();

      await service.handleCandidate(ctx, 'wo', 1);

      expect(discovery.approve).toHaveBeenCalledWith(1, 'web_only');
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('добавлен'));
    });

    it('approve не удался → предупреждение', async () => {
      const { service } = setup();
      const discovery = (service as never as { discovery: any }).discovery;
      discovery.approve.mockResolvedValue(null);
      const ctx = makeCtx();

      await service.handleCandidate(ctx, 'jo', 1);

      expect(discovery.approve).toHaveBeenCalledWith(1, 'join');
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Не удалось добавить (см. лог)');
    });

    it('edit падает → не роняем', async () => {
      const { service } = setup();
      const ctx = makeCtx();
      ctx.editMessageText.mockRejectedValue(new Error('gone'));

      await service.handleCandidate(ctx, 'rj', 1);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отклонён');
    });
  });
});
