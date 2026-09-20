import { Menu, MenuRange } from '@grammyjs/menu';
import { SourceCategory, SourceStatus } from '../constants/parser.constants';
import { ParserMenuService } from './parser-menu.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

type CapturedButton = {
  menuId: string;
  label: unknown;
  handler: (ctx: unknown) => Promise<void> | void;
};

const makeCtx = (overrides: Record<string, unknown> = {}): any => ({
  menu: { update: jest.fn().mockReturnThis() },
  answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  from: { id: 1 },
  config: { isOwner: true },
  api: { sendMessage: jest.fn().mockResolvedValue(undefined) },
  ...overrides,
});

describe('ParserMenuService (кнопки)', () => {
  let captured: CapturedButton[];
  let dynamicFns: Array<() => Promise<MenuRange<never>>>;
  let backCaptured: string | undefined;

  const makeDeps = () => {
    const settings = {
      current: {
        enabled: true,
        dailyLimit: 12,
        sourceDailyCap: 2,
        cringeShare: 0.25,
        evalFinalHours: 12,
        errMin: 0.15,
        maxSources: 20,
        aiEnabled: false,
      },
      update: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
    };
    const registry = {
      listAll: jest.fn().mockResolvedValue([
        { id: 1, chatId: '-1001', title: 'Memes', category: SourceCategory.MEMES, status: SourceStatus.ACTIVE },
      ]),
      countCollectible: jest.fn().mockResolvedValue(1),
      toggleStatus: jest.fn().mockResolvedValue(undefined),
      setCategory: jest.fn().mockResolvedValue(undefined),
      importSubscriptions: jest.fn().mockResolvedValue(3),
    };
    const discovery = {
      repository: { count: jest.fn().mockResolvedValue(2) },
      listReady: jest.fn().mockResolvedValue([
        { id: 5, title: 'Cand', username: 'cand', mentions: 2, subscribers: 100, errEstimate: 0.2, postsPerDay: 5, aiVerdict: null },
      ]),
    };
    const delivery = { buildCandidateKeyboard: jest.fn().mockReturnValue({}) };
    const repo = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(4),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };
    const bot = { api: { sendMessage: jest.fn().mockResolvedValue(undefined) } };

    const service = new ParserMenuService(
      bot as never,
      repo as never,
      settings as never,
      registry as never,
      discovery as never,
      delivery as never
    );
    return { service, settings, registry, discovery, delivery, repo, bot };
  };

  beforeEach(() => {
    captured = [];
    dynamicFns = [];
    backCaptured = undefined;
    jest
      .spyOn(Menu.prototype, 'text')
      .mockImplementation(function (label: unknown, handler: never) {
        captured.push({ menuId: (this as { id?: string }).id ?? '', label, handler });
        return this as never;
      });
    jest.spyOn(Menu.prototype, 'dynamic').mockImplementation(function (fn: never) {
      dynamicFns.push(fn as never);
      return this as never;
    });
    jest.spyOn(Menu.prototype, 'row').mockImplementation(function () {
      return this as never;
    });
    jest.spyOn(Menu.prototype, 'back').mockImplementation(function (label: string) {
      backCaptured = label;
      return this as never;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const buttons = (): CapturedButton[] => captured;

  const findButton = async (needle: string): Promise<CapturedButton> => {
    for (const button of captured) {
      const label = typeof button.label === 'function' ? await (button.label as () => Promise<string>)() : (button.label as string);
      if (label?.includes(needle)) return button;
    }
    throw new Error(`button ${needle} not found`);
  };

  const rangeButtons = (range: unknown): Array<{ text: unknown; middleware: unknown }> => {
    const symbol = Object.getOwnPropertySymbols(range)[0];
    const rows = (range as unknown as Record<symbol, unknown[]>)[symbol] as unknown as Array<
      Array<{ text: unknown; middleware?: unknown }>
    >;
    return rows.flat(2).filter((op) => op && 'middleware' in op && op.middleware !== undefined) as Array<{
      text: unknown;
      middleware: unknown;
    }>;
  };

  it('меню собирается: статичные и динамические блоки, заголовок', async () => {
    const { service } = makeDeps();
    service.onModuleInit();
    service.getMenu();

    expect(buttons().length).toBeGreaterThanOrEqual(10);
    expect(dynamicFns.length).toBe(1);
    expect(backCaptured).toBe('Назад');

    const header = await (buttons()[0].label as () => Promise<string>)();
    expect(header).toContain('🧭 Парсер');
    expect(header).toContain('лимит 12');
    expect(header).toContain('⏳ 0 · 🧮 0 · ✅ 4/день');
  });

  it('переключатели пресетов циклят значения', async () => {
    const { service, settings } = makeDeps();
    service.onModuleInit();

    await (await findButton('Конвейер')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ enabled: false });

    await (await findButton('Лимит/сутки')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ dailyLimit: 15 });

    await (await findButton('Лимит/источник')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ sourceDailyCap: 3 });

    await (await findButton('Кринж-доля')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ cringeShare: 0.5 });

    await (await findButton('ERR min')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ errMin: 0.25 });

    await (await findButton('Финал через')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ evalFinalHours: 24 });

    await (await findButton('Макс. источников')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ maxSources: 30 });

    await (await findButton('AI (DeepSeek)')).handler(makeCtx());
    expect(settings.update).toHaveBeenCalledWith({ aiEnabled: true });
  });

  it('источники: тумблер и категория по кнопкам', async () => {
    const { service, registry } = makeDeps();
    service.onModuleInit();

    const range = await dynamicFns[0]();
    const symbol = Object.getOwnPropertySymbols(range)[0];
    const sourceButtons = rangeButtons(range);
    expect(sourceButtons.length).toBe(2);

    const first = sourceButtons[0] as { middleware: Array<(ctx: unknown) => Promise<void>> };
    await first.middleware[0](makeCtx());
    expect(registry.toggleStatus).toHaveBeenCalledWith(1);

    const second = sourceButtons[1] as { middleware: Array<(ctx: unknown) => Promise<void>> };
    await second.middleware[0](makeCtx());
    expect(registry.setCategory).toHaveBeenCalledWith(1, SourceCategory.CRINGE);
  });

  it('импорт подписок вызывает registry', async () => {
    const { service, registry } = makeDeps();
    service.onModuleInit();

    const importButton = buttons().find((button) => {
      const label = typeof button.label === 'function' ? undefined : (button.label as string);
      return label?.includes('Импорт');
    });
    await importButton!.handler(makeCtx());

    expect(registry.importSubscriptions).toHaveBeenCalledTimes(1);
  });

  it('кандидаты: карточки уходят владельцу', async () => {
    const { service, bot, delivery } = makeDeps();
    service.onModuleInit();

    await (await findButton('Кандидаты')).handler(makeCtx());

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(delivery.buildCandidateKeyboard).toHaveBeenCalledWith(5);
  });

  it('сброс настроек', async () => {
    const { service, settings } = makeDeps();
    service.onModuleInit();

    await (await findButton('↩️ Сброс')).handler(makeCtx());

    expect(settings.reset).toHaveBeenCalledTimes(1);
  });
});
