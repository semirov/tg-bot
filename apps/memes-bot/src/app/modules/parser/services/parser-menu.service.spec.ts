import { Menu } from '@grammyjs/menu';
import { InlineKeyboard } from 'grammy';
import { SourceStatus, ObservedStatus } from '../constants/parser.constants';
import { ParserMenuService } from './parser-menu.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

type CapturedButton = {
  label: unknown;
  handler: (ctx: any) => Promise<void> | void;
};

const makeCtx = (overrides: Record<string, unknown> = {}): any => ({
  menu: { update: jest.fn().mockReturnThis() },
  answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
  from: { id: 1 },
  config: { isOwner: true },
  ...overrides,
});

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1001',
  username: 'chan',
  title: 'Memes',
  status: SourceStatus.ACTIVE,
  takenTotal: 2,
  weight: 1.5,
  err: 0.2,
  excluded: false,
  ...overrides,
});

describe('ParserMenuService', () => {
  let captured: CapturedButton[];

  const makeDeps = () => {
    const settings = {
      current: {
        enabled: true,
        evalFinalHours: 12,
        errMin: 0.15,
        aiEnabled: false,
        boostUntil: null,
        legacyEnabled: true,
      },
      update: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
      boostActive: jest.fn(() => false),
    };
    const registry = {
      listCollectible: jest.fn().mockResolvedValue([]),
      listExcluded: jest.fn().mockResolvedValue([]),
      listPopular: jest.fn().mockResolvedValue([]),
      countCollectible: jest.fn().mockResolvedValue(0),
      countPopular: jest.fn().mockResolvedValue(0),
      countExcluded: jest.fn().mockResolvedValue(0),
      restoreSource: jest.fn().mockResolvedValue({ id: 1 }),
      excludeSource: jest.fn().mockResolvedValue(true),
      importSubscriptions: jest.fn().mockResolvedValue(3),
    };
    const builder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(4),
    };
    const repo = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => builder),
    };
    const bot = { api: { sendMessage: jest.fn().mockResolvedValue(undefined) }, callbackQuery: jest.fn() };
    const service = new ParserMenuService(bot as never, repo as never, settings as never, registry as never);
    return { service, settings, registry, repo, builder, bot };
  };

  beforeEach(() => {
    captured = [];
    jest.spyOn(Menu.prototype, 'text').mockImplementation(function (label: unknown, handler: never) {
      captured.push({ label, handler });
      return this as never;
    });
    jest.spyOn(Menu.prototype, 'row').mockImplementation(function () {
      return this as never;
    });
    jest.spyOn(Menu.prototype, 'back').mockImplementation(function () {
      return this as never;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const findButton = async (needle: string): Promise<CapturedButton> => {
    for (const button of captured) {
      const label =
        typeof button.label === 'function'
          ? await (button.label as () => Promise<string>)()
          : (button.label as string);
      if (label?.includes(needle)) return button;
    }
    throw new Error(`button ${needle} not found`);
  };

  it('onModuleInit строит меню и регистрирует callbacks пагинации/возврата/исключения', () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();

    expect(bot.callbackQuery).toHaveBeenCalledTimes(5);
    const sources = bot.callbackQuery.mock.calls.map((call: any[]) => call[0].source);
    expect(sources).toEqual([
      '^pl:(pop|exc|src):(\\d+)$',
      '^pl:restore:(\\d+):(\\d+)$',
      '^pl:excl:(\\d+):(pop|src):(\\d+)$',
      '^pl:exclno:(\\d+):(pop|src):(\\d+)$',
      '^pl:exclok:(\\d+):(pop|src):(\\d+)$',
    ]);
    expect(service.getMenu()).toBeDefined();
    expect(captured.length).toBeGreaterThanOrEqual(8);
  });

  it('заголовок отражает состояние и статистику', async () => {
    const { service } = makeDeps();
    service.onModuleInit();

    const header = await (captured[0].label as () => Promise<string>)();
    expect(header).toContain('🧭 Парсер');
    expect(header).toContain('🟢');
    expect(header).toContain('⏳ 0 · 🧮 0 · ✅ 4/день');
  });

  it('тумблер legacyEnabled пишет настройки', async () => {
    const { service, settings } = makeDeps();
    service.onModuleInit();

    await (await findButton('Старый парсер')).handler(makeCtx());

    expect(settings.update).toHaveBeenCalledWith({ legacyEnabled: false });
  });

  it('кнопка импорта подписок вызывает реестр', async () => {
    const { service, registry } = makeDeps();
    service.onModuleInit();

    await (await findButton('Импорт')).handler(makeCtx());
    expect(registry.importSubscriptions).toHaveBeenCalledTimes(1);
  });

  it('сброс настроек', async () => {
    const { service, settings } = makeDeps();
    service.onModuleInit();

    await (await findButton('Сброс')).handler(makeCtx());
    expect(settings.reset).toHaveBeenCalledTimes(1);
  });

  it('sendList отправляет сообщение без callbackQuery', async () => {
    const { service, registry, bot } = makeDeps();
    registry.listPopular.mockResolvedValue([source()]);
    service.onModuleInit();

    await service.sendList(makeCtx({ callbackQuery: undefined }), 'pop', 0);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining('🏆 Популярные источники'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('sendList без from отправляет в 0', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();

    await service.sendList(makeCtx({ from: undefined, callbackQuery: undefined }), 'pop', 0);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(0, expect.any(String), expect.anything());
  });

  it('callback restore без match не роняет', async () => {
    const { service, bot, registry } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[1][1];
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } }, match: undefined });

    await expect(handler(ctx)).resolves.toBeUndefined();
    expect(registry.restoreSource).toHaveBeenCalled();
  });

  it('sendList редактирует сообщение при callbackQuery', async () => {
    const { service, registry } = makeDeps();
    registry.listCollectible.mockResolvedValue([source()]);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'src', 0);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('📚 Все источники'),
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('sendList: пустой список и отрицательная страница', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();

    await service.sendList(makeCtx({ callbackQuery: undefined }), 'exc', -3);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining('— пусто —'),
      expect.anything()
    );
  });

  it('sendList: ошибка отправки не роняет', async () => {
    const { service, bot } = makeDeps();
    bot.api.sendMessage.mockRejectedValue(new Error('blocked'));
    service.onModuleInit();

    await expect(service.sendList(makeCtx({ callbackQuery: undefined }), 'pop', 0)).resolves.toBeUndefined();
  });

  it('пагинация: страница >0 даёт навигацию, исключённые — кнопки возврата', async () => {
    const { service, registry } = makeDeps();
    const rows = Array.from({ length: 10 }, (_, index) => source({ id: index + 1 }));
    registry.listExcluded.mockResolvedValue(rows);
    registry.countExcluded.mockResolvedValue(18);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'exc', 1);

    expect(registry.countExcluded).toHaveBeenCalled();
    const keyboard = ctx.editMessageText.mock.calls[0][1].reply_markup as unknown as {
      inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
    };
    const data = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
    expect(data).toContain('pl:exc:0');
    expect(data.some((value) => value.startsWith('pl:restore:'))).toBe(true);
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('стр. 2/3');
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('↩️ Вернуть 9');
  });

  it('пагинация: неполная вторая страница popular', async () => {
    const { service, registry } = makeDeps();
    registry.listPopular.mockResolvedValue([source()]);
    registry.countPopular.mockResolvedValue(9);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'pop', 1);

    expect(registry.listPopular).toHaveBeenCalledWith(8, 8);
    expect(registry.countPopular).toHaveBeenCalled();
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('стр. 2/2');
  });

  it('callback пагинации вызывает sendList', async () => {
    const { service, bot, registry } = makeDeps();
    registry.listPopular.mockResolvedValue([]);
    service.onModuleInit();

    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } }, match: ['pl:pop:0', 'pop', '0'] });
    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('callback restore возвращает источник и перерисовывает список', async () => {
    const { service, bot, registry } = makeDeps();
    registry.listExcluded.mockResolvedValue([]);
    service.onModuleInit();

    const handler = bot.callbackQuery.mock.calls[1][1];
    const ctx = makeCtx({
      callbackQuery: { message: { message_id: 5 } },
      match: ['pl:restore:1:0', '1', '0'],
    });
    await handler(ctx);

    expect(registry.restoreSource).toHaveBeenCalledWith(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Источник возвращён');
  });

  it('callback restore: источник не найден', async () => {
    const { service, bot, registry } = makeDeps();
    registry.restoreSource.mockResolvedValue(null);
    service.onModuleInit();

    const handler = bot.callbackQuery.mock.calls[1][1];
    const ctx = makeCtx({
      callbackQuery: { message: { message_id: 5 } },
      match: ['pl:restore:99:0', '99', '0'],
    });
    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Не найден');
  });

  it('sourceLine: иконки исключённого/web-only/active и ERR', async () => {
    const { service, registry } = makeDeps();
    registry.listCollectible.mockResolvedValue([
      source({ id: 1, excluded: true, status: SourceStatus.DISABLED, title: 'A', err: null }),
      source({ id: 2, excluded: false, status: SourceStatus.WEB_ONLY, title: null, username: 'web', err: null }),
      source({ id: 3, excluded: false, status: SourceStatus.ACTIVE, title: '<b>', err: 0.12 }),
    ]);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'src', 0);

    const text = ctx.editMessageText.mock.calls[0][0] as string;
    expect(text).toContain('🚫');
    expect(text).toContain('🌐');
    expect(text).toContain('🟢');
    expect(text).toContain('ERR 12.0%');
    expect(text).toContain('&lt;b&gt;');
  });

  it('полная страница popular и пагинация на страницы вперёд/назад', async () => {
    const { service, registry } = makeDeps();
    registry.listPopular.mockResolvedValue(Array.from({ length: 8 }, (_, index) => source({ id: index + 1 })));
    registry.countPopular.mockResolvedValue(17);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'pop', 1);

    const keyboard = ctx.editMessageText.mock.calls[0][1].reply_markup as unknown as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const data = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
    expect(data).toContain('pl:pop:0');
    expect(data).toContain('pl:pop:2');
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('стр. 2/3');
  });

  it('популярные: кнопки исключения pl:excl идут матрицей по 4 и содержат номер', async () => {
    const { service, registry } = makeDeps();
    registry.listPopular.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => source({ id: index + 1 }))
    );
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'pop', 0);

    const keyboard = ctx.editMessageText.mock.calls[0][1].reply_markup as unknown as {
      inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
    };
    const actionRows = keyboard.inline_keyboard.filter((row) =>
      row.every((button) => button.callback_data.startsWith('pl:excl:'))
    );
    expect(actionRows).toHaveLength(2);
    expect(actionRows[0]).toHaveLength(4);
    expect(actionRows[1]).toHaveLength(2);
    expect(actionRows[0][0]).toEqual({ text: '🚫 1', callback_data: 'pl:excl:1:pop:0' });
    expect(actionRows[1][1]).toEqual({ text: '🚫 6', callback_data: 'pl:excl:6:pop:0' });
  });

  it('исключённые: кнопки возврата переносятся по строкам', async () => {
    const { service, registry } = makeDeps();
    registry.listExcluded.mockResolvedValue(Array.from({ length: 8 }, (_, index) => source({ id: index + 1 })));
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'exc', 0);

    const keyboard = ctx.editMessageText.mock.calls[0][1].reply_markup as unknown as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const restoreRows = keyboard.inline_keyboard.filter((row) =>
      row.every((button) => button.callback_data.startsWith('pl:restore:'))
    );
    expect(restoreRows.length).toBeGreaterThanOrEqual(2);
  });

  it('sourceLine с null title/username падает на chatId', async () => {
    const { service, registry } = makeDeps();
    registry.listCollectible.mockResolvedValue([
      source({ id: 1, title: null, username: null, chatId: '-100999', status: SourceStatus.ACTIVE, err: null }),
    ]);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'src', 0);

    expect(ctx.editMessageText.mock.calls[0][0]).toContain('-100999');
  });

  it('sourceLine: заголовок оборачивается ссылкой (username и приватный канал)', async () => {
    const { service, registry } = makeDeps();
    registry.listCollectible.mockResolvedValue([
      source({ id: 1, username: 'memes', title: 'Public', chatId: '-1001' }),
      source({ id: 2, username: null, title: 'Private', chatId: '-1001234567890' }),
      source({ id: 3, username: null, title: 'NoChat', chatId: null }),
    ]);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'src', 0);

    const text = ctx.editMessageText.mock.calls[0][0] as string;
    expect(text).toContain('<a href="https://t.me/memes"><b>Public</b></a>');
    expect(text).toContain('<a href="https://t.me/c/1234567890"><b>Private</b></a>');
    expect(text).toContain('<b>NoChat</b>');
  });

  it('channelLink: username → t.me, приватный → t.me/c', () => {
    const { service } = makeDeps();

    expect(service.channelLink(source({ username: 'chan' }))).toBe('https://t.me/chan');
    expect(service.channelLink(source({ username: null, chatId: '-1001234567890' }))).toBe(
      'https://t.me/c/1234567890'
    );
  });

  it('channelLink: пустой/нулевой/нечисловой chatId → null (без <a>)', async () => {
    const { service, registry } = makeDeps();
    registry.listCollectible.mockResolvedValue([
      source({ id: 1, username: null, title: 'Empty', chatId: '' }),
      source({ id: 2, username: null, title: 'Zero', chatId: '0' }),
      source({ id: 3, username: null, title: 'NaN', chatId: 'not-a-number' }),
    ]);

    expect(service.channelLink(source({ username: null, chatId: '' }))).toBeNull();
    expect(service.channelLink(source({ username: null, chatId: '0' }))).toBeNull();
    expect(service.channelLink(source({ username: null, chatId: 'abc' }))).toBeNull();

    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });
    await service.sendList(ctx, 'src', 0);

    const text = ctx.editMessageText.mock.calls[0][0] as string;
    expect(text).toContain('<b>Empty</b>');
    expect(text).toContain('<b>Zero</b>');
    expect(text).toContain('<b>NaN</b>');
    expect(text).not.toContain('<a href');
  });

  it('заголовок «Популярные» берёт счётчик из registry.countPopular', async () => {
    const { service, registry } = makeDeps();
    registry.countPopular.mockResolvedValue(7);
    service.onModuleInit();

    expect(await (captured[7].label as () => Promise<string>)()).toBe('🏆 Популярные (7)');
  });

  it('callbacks pl:* отклоняют не-владельца', async () => {
    const { service, bot, registry } = makeDeps();
    service.onModuleInit();
    const ctx = makeCtx({
      config: { isOwner: false },
      match: ['pl:pop:0', 'pop', '0'],
    });

    for (let index = 0; index < 5; index += 1) {
      ctx.answerCallbackQuery.mockClear();
      await bot.callbackQuery.mock.calls[index][1](ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Только владелец');
    }
    expect(registry.restoreSource).not.toHaveBeenCalled();
    expect(registry.excludeSource).not.toHaveBeenCalled();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it('callbacks pl:* при отсутствии config считают чужаком', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const ctx = makeCtx({ config: undefined, match: [] });

    for (let index = 0; index < 5; index += 1) {
      ctx.answerCallbackQuery.mockClear();
      await bot.callbackQuery.mock.calls[index][1](ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Только владелец');
    }
  });

  it('pl:excl запрашивает подтверждение и подменяет клавиатуру', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[2][1];
    const ctx = makeCtx({
      match: ['pl:excl:7:pop:2', '7', 'pop', '2'],
    });

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Исключить источник?');
    const keyboard = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup as InlineKeyboard;
    expect(keyboard.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([
      'pl:exclok:7:pop:2',
      'pl:exclno:7:pop:2',
    ]);
  });

  it('pl:exclno отменяет и перерисовывает список', async () => {
    const { service, bot, registry } = makeDeps();
    registry.listPopular.mockResolvedValue([]);
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[3][1];
    const ctx = makeCtx({
      callbackQuery: { message: { message_id: 5 } },
      match: ['pl:exclno:7:pop:2', '7', 'pop', '2'],
    });

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отменено');
    expect(registry.excludeSource).not.toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('pl:exclok исключает источник и перерисовывает список', async () => {
    const { service, bot, registry } = makeDeps();
    registry.excludeSource.mockResolvedValue(true);
    registry.listPopular.mockResolvedValue([]);
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[4][1];
    const ctx = makeCtx({
      callbackQuery: { message: { message_id: 5 } },
      match: ['pl:exclok:7:pop:2', '7', 'pop', '2'],
    });

    await handler(ctx);

    expect(registry.excludeSource).toHaveBeenCalledWith(7);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Источник исключён');
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('pl:exclok: источник не найден', async () => {
    const { service, bot, registry } = makeDeps();
    registry.excludeSource.mockResolvedValue(null);
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[4][1];
    const ctx = makeCtx({
      callbackQuery: { message: { message_id: 5 } },
      match: ['pl:exclok:99:pop:0', '99', 'pop', '0'],
    });

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Не найден');
  });

  it('pl:excl: ошибка замены клавиатуры не роняет', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[2][1];
    const ctx = makeCtx({
      match: ['pl:excl:7:pop:2', '7', 'pop', '2'],
    });
    ctx.editMessageReplyMarkup.mockRejectedValue(new Error('too old'));

    await expect(handler(ctx)).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Исключить источник?');
  });

  it('pl:excl без match не роняет', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[2][1];
    const ctx = makeCtx({ match: undefined });

    await expect(handler(ctx)).resolves.toBeUndefined();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Исключить источник?');
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it('pl:exclno без match перерисовывает список', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[3][1];
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } }, match: undefined });

    await expect(handler(ctx)).resolves.toBeUndefined();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Отменено');
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('pl:exclok без match не роняет', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[4][1];
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } }, match: undefined });

    await expect(handler(ctx)).resolves.toBeUndefined();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Источник исключён');
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('callback пагинации без match не роняет', async () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await expect(handler(ctx)).resolves.toBeUndefined();
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('тумблер legacy во втором состоянии', async () => {
    const { service, settings } = makeDeps();
    settings.current.legacyEnabled = false;
    service.onModuleInit();

    await (await findButton('Старый парсер')).handler(makeCtx());

    expect(settings.update).toHaveBeenCalledWith({ legacyEnabled: true });
    expect(settings.current.legacyEnabled).toBe(false);
  });

  it('все кнопки меню вызывают свои обработчики', async () => {
    const { service, settings, registry } = makeDeps();
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    for (const button of captured) {
      if (typeof button.label === 'function') await (button.label as () => Promise<string>)();
      await button.handler(ctx);
    }

    expect(settings.update).toHaveBeenCalled();
    expect(settings.reset).toHaveBeenCalled();
    expect(registry.importSubscriptions).toHaveBeenCalled();
    expect(ctx.menu.update).toHaveBeenCalled();
  });

  it('лейблы отрабатывают оба состояния настроек', async () => {
    const { service, settings } = makeDeps();
    service.onModuleInit();

    for (const enabled of [true, false]) {
      for (const aiEnabled of [true, false]) {
        for (const legacyEnabled of [true, false]) {
          settings.current.enabled = enabled;
          settings.current.aiEnabled = aiEnabled;
          settings.current.legacyEnabled = legacyEnabled;
          for (const button of captured) {
            if (typeof button.label === 'function') {
              const label = await (button.label as () => Promise<string>)();
              expect(typeof label).toBe('string');
            }
          }
        }
      }
    }
  });

  it('statsLine собирает счётчики', async () => {
    const { service, repo, builder } = makeDeps();
    repo.count.mockImplementation(async ({ where }: any) =>
      where.status === ObservedStatus.PENDING ? 2 : 3
    );
    builder.getCount.mockResolvedValue(7);

    expect(await service.statsLine()).toBe('⏳ 2 · 🧮 3 · ✅ 7/день');
  });
});
