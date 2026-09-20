import { Menu } from '@grammyjs/menu';
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
      restoreSource: jest.fn().mockResolvedValue({ id: 1 }),
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

  it('onModuleInit строит меню и регистрирует callback пагинации', () => {
    const { service, bot } = makeDeps();
    service.onModuleInit();

    expect(bot.callbackQuery).toHaveBeenCalledTimes(2);
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

  it('boost-тумблер включает и выключает', async () => {
    const { service, settings } = makeDeps();
    service.onModuleInit();

    const boostButton = captured.find(
      (button) => typeof button.label === 'function' && (button.label as () => string)() === '🍲 Насыпать ещё'
    )!;
    await boostButton.handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ boostUntil: expect.any(String) });

    settings.boostActive.mockReturnValue(true);
    settings.update.mockClear();
    await boostButton.handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ boostUntil: null });
  });

  it('boostLabel показывает остаток при активном boost', async () => {
    const { service, settings } = makeDeps();
    settings.current.boostUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    settings.boostActive.mockReturnValue(true);
    service.onModuleInit();

    const button = await findButton('Boost ещё');
    expect(String(await (button.label as () => Promise<string>)())).toContain('Boost ещё');
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
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'exc', 1);

    const keyboard = ctx.editMessageText.mock.calls[0][1].reply_markup as unknown as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const data = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
    expect(data).toContain('pl:exc:0');
    expect(data.some((value) => value.startsWith('pl:restore:'))).toBe(true);
    expect(ctx.editMessageText.mock.calls[0][0]).toContain('стр. 2/');
  });

  it('пагинация: неполная страница popular', async () => {
    const { service, registry } = makeDeps();
    registry.listPopular.mockResolvedValue([source()]);
    service.onModuleInit();
    const ctx = makeCtx({ callbackQuery: { message: { message_id: 5 } } });

    await service.sendList(ctx, 'pop', 2);

    expect(ctx.editMessageText).toHaveBeenCalled();
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
