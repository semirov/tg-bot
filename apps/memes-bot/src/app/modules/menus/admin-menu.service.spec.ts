import { Menu, MenuRange } from '@grammyjs/menu';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { Logger } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';

// axios — ESM и не парсится jest; DeepSeekService в тестах не используется.
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ post: jest.fn() })) },
  isAxiosError: () => false,
}));

import { AdminMenuService } from './admin-menu.service';
import { AdminMenusEnum } from './constants/bot-menus.enum';
import { ConversationsEnum } from '../post-management/constants/conversations.enum';
import { PublicationModesEnum } from '../post-management/constants/publication-modes.enum';

/**
 * Достаёт внутренний массив операций сборки меню (@grammyjs/menu хранит его под
 * приватным символом). Нужен, чтобы добраться до middleware кнопок.
 */
function opsOf(obj: any): any[] | undefined {
  if (!obj) return undefined;
  const sym = Object.getOwnPropertySymbols(obj).find((s) =>
    String(s).includes('menu building')
  );
  return sym ? obj[sym] : undefined;
}

/** Повторяет внутренний layout @grammyjs/menu, но возвращает сырые кнопки. */
async function rawKeyboard(container: any, ctx: any): Promise<any[][]> {
  const seen = new WeakSet<object>();
  async function layout(keyboard: Promise<any[][]>, range: any): Promise<any[][]> {
    const k = await keyboard;
    const btns = typeof range === 'function' ? await range(ctx) : range;
    if (!btns) return k;
    if (typeof btns === 'object') {
      if (seen.has(btns)) return k;
      seen.add(btns);
    }
    if (btns instanceof MenuRange) {
      let acc: Promise<any[][]> = Promise.resolve(k);
      for (const inner of opsOf(btns) ?? []) acc = layout(acc, inner);
      return acc;
    }
    if (!Array.isArray(btns) && !(Symbol.iterator in Object(btns))) return k;
    let first = true;
    for (const row of btns) {
      if (!first) k.push([]);
      const i = k.length - 1;
      for (const button of row) k[i].push(button);
      first = false;
    }
    return k;
  }
  let acc: Promise<any[][]> = Promise.resolve([[]]);
  for (const op of opsOf(container) ?? []) acc = layout(acc, op);
  return acc;
}

/** Разворачивает текст кнопки (он может быть динамическим). */
async function buttonText(btn: any, ctx: any): Promise<string> {
  return typeof btn.text === 'function' ? btn.text(ctx) : btn.text;
}

async function findByText(
  menu: any,
  ctx: any,
  predicate: (text: string) => boolean
): Promise<any> {
  const kb = await rawKeyboard(menu, ctx);
  for (const row of kb) {
    for (const btn of row) {
      if (predicate(await buttonText(btn, ctx))) return btn;
    }
  }
  throw new Error('button not found');
}

async function findAllByText(
  menu: any,
  ctx: any,
  predicate: (text: string) => boolean
): Promise<any[]> {
  const kb = await rawKeyboard(menu, ctx);
  const found: any[] = [];
  for (const row of kb) {
    for (const btn of row) {
      if (predicate(await buttonText(btn, ctx))) found.push(btn);
    }
  }
  return found;
}

function makeCtx(overrides: any = {}): any {
  return {
    config: { isOwner: true, user: { isModerator: false } },
    session: {
      memeLimitControlState: undefined,
      memeLimitUserId: undefined,
      lastChangedModeratorId: undefined,
      yearResultsPreview: undefined,
      yearResultsCurrentUserIndex: undefined,
    },
    from: { id: 555, username: 'tester' },
    me: { username: 'memes_bot' },
    callbackQuery: { from: { id: 555 } },
    match: [],
    reply: jest.fn().mockResolvedValue({}),
    answerCallbackQuery: jest.fn().mockResolvedValue({}),
    editMessageReplyMarkup: jest.fn().mockResolvedValue({}),
    editMessageText: jest.fn().mockResolvedValue({}),
    api: {
      sendMessage: jest.fn().mockResolvedValue({}),
      createChatInviteLink: jest.fn().mockResolvedValue({ invite_link: 'https://t.me/+invite' }),
      getChat: jest.fn().mockResolvedValue({ title: 'Канал мемов' }),
      banChatMember: jest.fn().mockResolvedValue({}),
    },
    conversation: { enter: jest.fn() },
    menu: { nav: jest.fn(), update: jest.fn(), back: jest.fn() },
    ...overrides,
  };
}

function settingsBase(): any {
  return {
    enabled: true,
    criminalEnabled: true,
    criminalThreshold: 0.5,
    criminalHighThreshold: 0.8,
    analyzeCooldownSec: 10,
    sarcasmEnabled: true,
    sarcasmChance: 0.1,
    sarcasmCooldownSec: 300,
    mirrorEnabled: true,
    mirrorChance: 0.1,
    mirrorCooldownSec: 300,
    reactionEnabled: true,
    reactionChance: 0.1,
    reactionCooldownSec: 300,
    jerkEnabled: true,
    addressReactionEnabled: true,
    jerkBatchWindowSec: 15,
    jerkCooldownSec: 60,
    dialogPauseMin: 15,
    memeAnnounceEnabled: true,
    memeAnnounceChance: 0.1,
    dailyRequestLimit: 500,
    maxInputChars: 1000,
    selfCheckEnabled: true,
    selfCheckThreshold: 0.6,
  };
}

function makePost(mode: PublicationModesEnum, overrides: any = {}): any {
  return {
    mode,
    requestChannelMessageId: 42,
    publishDate: new Date('2026-09-15T09:30:00Z'),
    isUserPost: false,
    processedByModerator: { username: 'mod' },
    ...overrides,
  };
}

const PERMISSIONS = [
  {
    field: 'allowPublishToChannel',
    yes: 'Может публиковать',
    no: 'Не может публиковать',
    row: 1,
  },
  {
    field: 'allowDeleteRejectedPost',
    yes: 'Может удалять отклоненные',
    no: 'Не может удалять отклоненные',
    row: 2,
  },
  {
    field: 'allowRestoreDiscardedPost',
    yes: 'Может возвращать отклоненные',
    no: 'Не может возвращать отклоненные',
    row: 3,
  },
  { field: 'allowSetStrike', yes: 'Может выдавать страйки', no: 'Не может выдавать страйки', row: 4 },
  { field: 'allowMakeBan', yes: 'Может банить', no: 'Не может банить', row: 5 },
];

const TROLL_ROWS: { row: number; field: string; type: 'toggle' | 'cycle'; presets?: number[] }[] = [
  { row: 0, field: 'enabled', type: 'toggle' },
  { row: 1, field: 'criminalEnabled', type: 'toggle' },
  { row: 2, field: 'criminalThreshold', type: 'cycle', presets: [0.3, 0.4, 0.5, 0.6, 0.7] },
  { row: 3, field: 'criminalHighThreshold', type: 'cycle', presets: [0.7, 0.8, 0.9] },
  { row: 4, field: 'analyzeCooldownSec', type: 'cycle', presets: [0, 5, 10, 15, 30, 60] },
  { row: 5, field: 'sarcasmEnabled', type: 'toggle' },
  { row: 6, field: 'sarcasmChance', type: 'cycle', presets: [0.01, 0.03, 0.05, 0.1, 0.15, 0.2] },
  { row: 7, field: 'sarcasmCooldownSec', type: 'cycle', presets: [0, 60, 300, 600, 1800, 3600] },
  { row: 8, field: 'mirrorEnabled', type: 'toggle' },
  { row: 9, field: 'mirrorChance', type: 'cycle', presets: [0.01, 0.03, 0.05, 0.1, 0.15, 0.2] },
  { row: 10, field: 'mirrorCooldownSec', type: 'cycle', presets: [0, 60, 300, 600, 1800, 3600] },
  { row: 11, field: 'reactionEnabled', type: 'toggle' },
  { row: 12, field: 'reactionChance', type: 'cycle', presets: [0.01, 0.03, 0.05, 0.1, 0.15, 0.2] },
  { row: 13, field: 'reactionCooldownSec', type: 'cycle', presets: [0, 60, 300, 600, 1800, 3600] },
  { row: 14, field: 'jerkEnabled', type: 'toggle' },
  { row: 15, field: 'addressReactionEnabled', type: 'toggle' },
  { row: 16, field: 'jerkBatchWindowSec', type: 'cycle', presets: [0, 10, 15, 30, 60, 120] },
  { row: 17, field: 'jerkCooldownSec', type: 'cycle', presets: [0, 30, 60, 120, 180, 300, 600] },
  { row: 18, field: 'dialogPauseMin', type: 'cycle', presets: [5, 10, 15, 30, 60, 120, 360] },
  { row: 19, field: 'memeAnnounceEnabled', type: 'toggle' },
  { row: 20, field: 'memeAnnounceChance', type: 'cycle', presets: [0.05, 0.1, 0.2, 0.3, 0.5] },
  { row: 21, field: 'dailyRequestLimit', type: 'cycle', presets: [100, 200, 500, 1000, 2000, 5000, 10000] },
  { row: 22, field: 'maxInputChars', type: 'cycle', presets: [500, 800, 1000, 1500, 2000, 3000] },
  { row: 23, field: 'selfCheckEnabled', type: 'toggle' },
  { row: 24, field: 'selfCheckThreshold', type: 'cycle', presets: [0.4, 0.5, 0.6, 0.7, 0.8] },
];

describe('AdminMenuService', () => {
  let service: AdminMenuService;
  let bot: any;
  let userService: any;
  let baseConfigService: any;
  let clientBaseService: any;
  let postSchedulerService: any;
  let yearResultsService: any;
  let trollService: any;
  let trollSettings: any;
  let deepSeek: any;
  let parserModeration: any;

  beforeEach(() => {
    bot = {
      errorBoundary: jest.fn(),
      command: jest.fn(),
      callbackQuery: jest.fn(),
      api: { sendMessage: jest.fn().mockResolvedValue({}) },
    };
    userService = {
      repository: {
        findOne: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        find: jest.fn().mockResolvedValue([]),
      },
      getModerators: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      disableMemeLimitForUser: jest.fn().mockResolvedValue(undefined),
    };
    baseConfigService = {
      userRequestMemeChannel: -1001234567890,
      memeChanelId: -1009876543210,
      bestMemeChanelId: -1002222222222,
      ownerId: 999,
    };
    clientBaseService = {
      lastObserverStatus: jest.fn().mockResolvedValue(false),
      toggleChannelObserver: jest.fn().mockResolvedValue(undefined),
      postDailyBestMeme: jest.fn().mockResolvedValue(undefined),
    };
    postSchedulerService = {
      getScheduledPost: jest.fn().mockResolvedValue([]),
      getScheduledPostById: jest.fn().mockResolvedValue(null),
      countUpcoming: jest.fn().mockResolvedValue(0),
      getUpcomingPage: jest.fn().mockResolvedValue([]),
      removeById: jest.fn().mockResolvedValue(1),
    };
    yearResultsService = {
      generateYearResults: jest.fn(),
      formatGeneralStatistics: jest.fn().mockReturnValue('general-stats'),
      publishGeneralStatistics: jest.fn().mockResolvedValue(undefined),
      publishPersonalStatistics: jest.fn().mockResolvedValue(undefined),
      yearResultRepository: { find: jest.fn().mockResolvedValue([]) },
      formatPersonalMessage: jest.fn().mockReturnValue('personal-msg'),
    };
    trollService = {
      getAllChats: jest.fn().mockResolvedValue([]),
      setChatActive: jest.fn().mockResolvedValue(undefined),
    };
    trollSettings = {
      current: settingsBase(),
      update: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
    };
    deepSeek = { usage: { requests: 12, tokens: 3456, costUsd: 0.5, peak: false } };
    parserModeration = {
      unscheduleByMessageId: jest.fn().mockResolvedValue(true),
    };

    service = new AdminMenuService(
      bot,
      userService,
      baseConfigService,
      clientBaseService,
      postSchedulerService,
      yearResultsService,
      trollService,
      trollSettings,
      deepSeek,
      {
        getMenu: jest.fn().mockReturnValue(new Menu<BotContext>('PARSER_SETTINGS_MENU')),
      } as never,
      parserModeration
    );
  });

  function initCommands(): Record<string, any> {
    const commands: Record<string, any> = {};
    bot.command.mockImplementation((name: string, handler: any) => {
      commands[name] = handler;
    });
    service.onModuleInit();
    return commands;
  }

  function buildAdmin(): { menu: Menu<any>; userStartMenu: Menu<any>; moderatorStartMenu: Menu<any> } {
    const userStartMenu = new Menu<any>('user-start');
    const moderatorStartMenu = new Menu<any>('moderator-start');
    const menu = service.buildStartAdminMenu(userStartMenu, moderatorStartMenu);
    return { menu, userStartMenu, moderatorStartMenu };
  }

  describe('onModuleInit', () => {
    it('регистрирует errorBoundary (команды итогов года убраны)', () => {
      const logSpy = jest.spyOn(Logger, 'log').mockImplementation(() => undefined as any);
      service.onModuleInit();
      expect(bot.errorBoundary).toHaveBeenCalledTimes(1);

      const onError = bot.errorBoundary.mock.calls[0][0];
      onError(new Error('boom'));
      expect(logSpy).toHaveBeenCalled();
    });

  });

  describe('buildStartAdminMenu — главное меню и ownerGuard', () => {
    it('ownerGuard: не владельцу показывает отказ и не запускает обработчик', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx({ config: { isOwner: false, user: {} } });
      const btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Тролль'));
      await btn.middleware[0](ctx, jest.fn());
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
      expect(ctx.menu.nav).not.toHaveBeenCalled();
    });

    it('ownerGuard: глотает ошибку answerCallbackQuery', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx({ config: { isOwner: false, user: {} } });
      ctx.answerCallbackQuery.mockRejectedValue(new Error('query too old'));
      const btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Тролль'));
      await expect(btn.middleware[0](ctx, jest.fn())).resolves.toBeUndefined();
    });

    it('ownerGuard: при отсутствии config считает не владельцем', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx({ config: undefined });
      const btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Тролль'));
      await btn.middleware[0](ctx, jest.fn());
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
    });

    it('ownerGuard: владельцу разрешает навигацию', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Тролль'));
      await btn.middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith(AdminMenusEnum.TROLL_SETTINGS_MENU);
    });

    it('главное меню: порядок кнопок и отсутствие дублей', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      clientBaseService.lastObserverStatus.mockResolvedValue(false);
      const kb = await rawKeyboard(menu, ctx);
      const labels: string[] = [];
      for (const row of kb) for (const btn of row) labels.push(await buttonText(btn, ctx));

      expect(labels).toEqual([
        '👥 Модераторы',
        '➕ Добавить модератора',
        '🤖 Боты и парсеры',
        '📅 Публикации и акции',
        '📊 Итоги года',
        'Меню модератора',
        'Меню пользователя',
      ]);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it('кнопка "Модераторы" ведёт к списку', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const btn = await findByText(menu, ctx, (t) => t === '👥 Модераторы');
      await btn.middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith('moderators-list');
    });

    it('кнопка добавления модератора запускает диалог', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const btn = await findByText(menu, ctx, (t) => t === '➕ Добавить модератора');
      await btn.middleware[0](ctx, jest.fn());
      expect(ctx.conversation.enter).toHaveBeenCalledWith(
        ConversationsEnum.ADD_MODERATOR_CONVERSATION
      );
    });

    it('лимит мемов — ровно одна кнопка, ведущая в меню управления лимитом', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const btns = await findAllByText(menu.at('admin-publications'), ctx, (t) => t === '🎚 Управление лимитом мемов');
      expect(btns).toHaveLength(1);
      await btns[0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledTimes(1);
      expect(ctx.menu.nav).toHaveBeenCalledWith('meme-limit-control');
    });

    it('юзербот: текст зависит от статуса, клик переключает', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();

      clientBaseService.lastObserverStatus.mockResolvedValue(true);
      let btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Юзербот'));
      expect(await buttonText(btn, ctx)).toBe('👁 Юзербот: остановить');

      clientBaseService.lastObserverStatus.mockResolvedValue(false);
      btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Юзербот'));
      expect(await buttonText(btn, ctx)).toBe('👁 Юзербот: запустить');

      await btn.middleware[0](ctx, jest.fn());
      expect(clientBaseService.toggleChannelObserver).toHaveBeenCalledTimes(1);
      expect(ctx.menu.update).toHaveBeenCalledTimes(1);
    });

    it('юзербот: не-владельцу недоступен', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx({ config: { isOwner: false, user: {} } });
      const btn = await findByText(menu.at('admin-bots'), ctx, (t) => t.includes('Юзербот'));
      await btn.middleware[0](ctx, jest.fn());
      expect(clientBaseService.toggleChannelObserver).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
    });

    it('промо бота отправляет инлайн-кнопку в канал', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const btn = await findByText(menu.at('admin-publications'), ctx, (t) => t === '📣 Промо бота');
      await btn.middleware[0](ctx, jest.fn());

      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = bot.api.sendMessage.mock.calls[0];
      expect(chatId).toBe(baseConfigService.memeChanelId);
      expect(text).toContain('прислать посты');
      expect(opts.disable_notification).toBe(true);
      expect(opts.reply_markup).toBeInstanceOf(InlineKeyboard);
      expect(opts.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/memes_bot');
    });

    it('лучший пост дня отправляется в «Лучшее»', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const btn = await findByText(menu.at('admin-publications'), ctx, (t) => t === '🏆 Лучший пост в «Лучшее»');
      await btn.middleware[0](ctx, jest.fn());
      expect(clientBaseService.postDailyBestMeme).toHaveBeenCalledWith(-1002222222222);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Лучший пост опубликован в «Лучшее»');
    });

    it('лучший пост: не-владельцу недоступен', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx({ config: { isOwner: false, user: {} } });
      const btn = await findByText(menu.at('admin-publications'), ctx, (t) => t === '🏆 Лучший пост в «Лучшее»');
      await btn.middleware[0](ctx, jest.fn());
      expect(clientBaseService.postDailyBestMeme).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
    });

    it('кнопки меню модератора и пользователя отдают соответствующие клавиатуры', async () => {
      const { menu, userStartMenu, moderatorStartMenu } = buildAdmin();
      const ctx = makeCtx();

      const modBtn = await findByText(menu, ctx, (t) => t === 'Меню модератора');
      await modBtn.middleware[0](ctx, jest.fn());
      expect(ctx.reply).toHaveBeenCalledWith('Выбери то, что хочешь сделать', {
        reply_markup: moderatorStartMenu,
      });

      ctx.reply.mockClear();
      const userBtn = await findByText(menu, ctx, (t) => t === 'Меню пользователя');
      await userBtn.middleware[0](ctx, jest.fn());
      expect(ctx.reply).toHaveBeenCalledWith('Выбери то, что хочешь сделать', {
        reply_markup: userStartMenu,
      });
    });

    it('showPublicationGrid: forceSend шлёт новое сообщение, даже если есть callbackQuery', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      postSchedulerService.countUpcoming.mockResolvedValue(1);
      postSchedulerService.getUpcomingPage.mockResolvedValue([
        makePost(PublicationModesEnum.NEXT_NIGHT, {
          id: 77,
          requestChannelMessageId: 42,
          processedByModerator: { username: 'mod' },
        }),
      ]);

      const btn = await findByText(menu.at('admin-publications'), ctx, (t) => t === '📅 Сетка публикаций');
      await btn.middleware[0](ctx, jest.fn());

      expect(postSchedulerService.getUpcomingPage).toHaveBeenCalledWith(8, 0);
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      const [chatId, text, opts] = bot.api.sendMessage.mock.calls[0];
      expect(chatId).toBe(555);
      expect(text).toContain('<b>Сетка публикаций</b>');
      expect(text).toContain('стр. 1/1');
      expect(text).toContain('15.09 12:30');
      expect(text).toContain('<a href="https://t.me/c/1234567890/42">карточка</a>');
      expect(text).toContain('@mod');
      expect(opts.parse_mode).toBe('HTML');
      const datas = opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      expect(datas).toContain('sched:p:all:0');
      expect(datas).toContain('sched:off:all:0:77');
      const offBtn = opts.reply_markup.inline_keyboard
        .flat()
        .find((b: any) => b.callback_data.startsWith('sched:off:'));
      expect(offBtn.text).toContain('🚫 Снять');
    });

    it('showPublicationGrid: пустая сетка показывает заглушку', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      const btn = await findByText(menu.at('admin-publications'), ctx, (t) => t === '📅 Сетка публикаций');
      await btn.middleware[0](ctx, jest.fn());

      const [, text, opts] = bot.api.sendMessage.mock.calls[0];
      expect(text).toContain('— пусто —');
      const datas = opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      expect(datas).toContain('sched:p:all:0');
      expect(datas.filter((c: string) => c.startsWith('sched:off:'))).toHaveLength(0);
    });

    it('сетка: не-владельцу кнопка недоступна', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx({ config: { isOwner: false, user: {} } });
      const btn = await findByText(menu.at('admin-publications'), ctx, (t) => t === '📅 Сетка публикаций');
      await btn.middleware[0](ctx, jest.fn());
      expect(postSchedulerService.countUpcoming).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
    });

    it('getPostMessagesGrid: пустой список и список с постом', () => {
      const empty = service.getPostMessagesGrid('Ночь', PublicationModesEnum.NEXT_NIGHT, {});
      expect(empty).toContain('Постов нет');

      const filled = service.getPostMessagesGrid('Утро', PublicationModesEnum.NEXT_MORNING, {
        [PublicationModesEnum.NEXT_MORNING]: [makePost(PublicationModesEnum.NEXT_MORNING)],
      });
      expect(filled).toContain('<b>Утро:</b>');
      expect(filled).toContain('https://t.me/c/');
      expect(filled).toContain('@mod');
    });
  });

  describe('сетка публикаций: пагинация и снятие', () => {
    function callbacks(): Record<string, any> {
      service.onModuleInit();
      const handlers: Record<string, any> = {};
      for (const call of bot.callbackQuery.mock.calls) {
        if (call[0] instanceof RegExp) handlers[call[0].source] = call[1];
      }
      return handlers;
    }

    it('вторая страница: пропуск и обе навигационные кнопки', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:p:all:1', 'all', '1'] });
      postSchedulerService.countUpcoming.mockResolvedValue(17);
      postSchedulerService.getUpcomingPage.mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => ({
          id: 100 + i,
          requestChannelMessageId: i + 1,
          publishDate: new Date('2026-09-15T09:30:00Z'),
          processedByModerator: { username: 'mod' },
        }))
      );

      await handlers['^sched:p:(all|user|parser):(\\d+)$'](ctx);

      expect(postSchedulerService.getUpcomingPage).toHaveBeenCalledWith(8, 8);
      const [text, opts] = ctx.editMessageText.mock.calls[0];
      expect(text).toContain('стр. 2/3');
      const data = opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      expect(data).toContain('sched:p:all:0');
      expect(data).toContain('sched:p:all:2');
      expect(data.filter((c: string) => c.startsWith('sched:off:'))).toHaveLength(8);
    });

    it('sendSchedulePage: страница вне диапазона прижимается к последней', async () => {
      const ctx = makeCtx();
      postSchedulerService.countUpcoming.mockResolvedValue(17);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await service.sendSchedulePage(ctx, 9);

      expect(postSchedulerService.getUpcomingPage).toHaveBeenCalledWith(8, 16);
      expect(ctx.editMessageText.mock.calls[0][0]).toContain('стр. 3/3');
    });

    it('sendSchedulePage: нечисловая страница трактуется как первая', async () => {
      const ctx = makeCtx();
      postSchedulerService.countUpcoming.mockResolvedValue(1);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await service.sendSchedulePage(ctx, NaN);

      expect(postSchedulerService.getUpcomingPage).toHaveBeenCalledWith(8, 0);
      expect(ctx.editMessageText.mock.calls[0][0]).toContain('стр. 1/1');
    });

    it('sendSchedulePage без callbackQuery шлёт новое сообщение', async () => {
      const ctx = makeCtx({ callbackQuery: undefined });
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await service.sendSchedulePage(ctx, 0);

      expect(bot.api.sendMessage).toHaveBeenCalledWith(555, expect.any(String), {
        parse_mode: 'HTML',
        reply_markup: expect.any(InlineKeyboard),
      });
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('sendSchedulePage с forceSend шлёт новое сообщение вместо edit', async () => {
      const ctx = makeCtx();
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await service.sendSchedulePage(ctx, 0, true);

      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).toHaveBeenCalledWith(555, expect.any(String), {
        parse_mode: 'HTML',
        reply_markup: expect.any(InlineKeyboard),
      });
    });

    it('строка без модератора не показывает @username', async () => {
      const ctx = makeCtx();
      postSchedulerService.countUpcoming.mockResolvedValue(1);
      postSchedulerService.getUpcomingPage.mockResolvedValue([
        {
          id: 5,
          requestChannelMessageId: 9,
          publishDate: new Date('2026-09-15T09:30:00Z'),
          processedByModerator: null,
        },
      ]);

      await service.sendSchedulePage(ctx, 0);

      const text = ctx.editMessageText.mock.calls[0][0];
      expect(text).toContain('15.09 12:30');
      expect(text).not.toContain('@');
    });

    it('без from новое сообщение уходит владельцу', async () => {
      const ctx = makeCtx({ callbackQuery: undefined, from: undefined });
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await service.sendSchedulePage(ctx, 0);

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        baseConfigService.ownerId,
        expect.any(String),
        expect.any(Object)
      );
    });

    it('p без match трактуется как первая страница', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: undefined });
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await handlers['^sched:p:(all|user|parser):(\\d+)$'](ctx);

      expect(postSchedulerService.getUpcomingPage).toHaveBeenCalledWith(8, 0);
    });

    it('ошибка перерисовки сетки не роняет', async () => {
      const ctx = makeCtx();
      ctx.editMessageText.mockRejectedValue(new Error('message is not modified'));
      const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined as any);
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await expect(service.sendSchedulePage(ctx, 0)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('ошибка клавиатуры confirm-снятия не роняет', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:off:all:0:77', 'all', '0', '77'] });
      ctx.editMessageReplyMarkup.mockRejectedValue(new Error('message is not modified'));
      const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined as any);

      await expect(handlers['^sched:off:(all|user|parser):(\\d+):(\\d+)$'](ctx)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('sched:off рисует confirm-клавиатуру', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:off:all:0:77', 'all', '0', '77'] });

      await handlers['^sched:off:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Снять с публикации?');
      const keyboard = ctx.editMessageReplyMarkup.mock.calls[0][0].reply_markup as InlineKeyboard;
      expect(keyboard.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([
        'sched:offok:all:0:77',
        'sched:offno:all:0:77',
      ]);
    });

    it('sched:offok снимает по id и перерисовывает сетку', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:offok:all:0:77', 'all', '0', '77'] });
      postSchedulerService.removeById.mockResolvedValue(1);

      await handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(postSchedulerService.removeById).toHaveBeenCalledWith(77);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Снято с публикации');
      expect(ctx.editMessageText).toHaveBeenCalled();
    });

    it('sched:offok с messageId снимает через parserModeration', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:offok:all:0:77', 'all', '0', '77'] });
      postSchedulerService.getScheduledPostById.mockResolvedValue({
        id: 77,
        requestChannelMessageId: 55,
      });
      parserModeration.unscheduleByMessageId.mockResolvedValue(true);

      await handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(postSchedulerService.getScheduledPostById).toHaveBeenCalledWith(77);
      expect(parserModeration.unscheduleByMessageId).toHaveBeenCalledWith(55);
      expect(postSchedulerService.removeById).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Снято с публикации');
    });

    it('sched:offok с messageId: уже снято → «Уже снято»', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:offok:all:0:77', 'all', '0', '77'] });
      postSchedulerService.getScheduledPostById.mockResolvedValue({
        id: 77,
        requestChannelMessageId: '55',
      });
      parserModeration.unscheduleByMessageId.mockResolvedValue(false);

      await handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(parserModeration.unscheduleByMessageId).toHaveBeenCalledWith(55);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Уже снято');
    });

    it('sched:offok: запись уже снята → «Уже снято»', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:offok:all:0:77', 'all', '0', '77'] });
      postSchedulerService.removeById.mockResolvedValue(0);

      await handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Уже снято');
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('sched:offok: ошибка удаления отвечает и логируется', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:offok:all:0:77', 'all', '0', '77'] });
      postSchedulerService.removeById.mockRejectedValue(new Error('db down'));
      const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined as any);
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await expect(handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx)).resolves.toBeUndefined();

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Ошибка снятия');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('sched:offno перерисовывает сетку', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: ['sched:offno:all:0:77', 'all', '0', '77'] });
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await handlers['^sched:offno:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Оставлено');
      expect(ctx.editMessageText).toHaveBeenCalled();
    });

    it('sched:off без match не роняет и подменяет клавиатуру', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: undefined });

      await expect(handlers['^sched:off:(all|user|parser):(\\d+):(\\d+)$'](ctx)).resolves.toBeUndefined();

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Снять с публикации?');
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
    });

    it('sched:offno без match уходит на первую страницу', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: undefined });
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await expect(handlers['^sched:offno:(all|user|parser):(\\d+):(\\d+)$'](ctx)).resolves.toBeUndefined();

      expect(postSchedulerService.getUpcomingPage).toHaveBeenCalledWith(8, 0);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Оставлено');
    });

    it('sched:offok без match снимает NaN-id и отвечает', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ match: undefined });
      postSchedulerService.countUpcoming.mockResolvedValue(0);
      postSchedulerService.getUpcomingPage.mockResolvedValue([]);

      await expect(handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx)).resolves.toBeUndefined();

      expect(postSchedulerService.removeById).toHaveBeenCalledWith(NaN);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Снято с публикации');
    });

    it('sendScheduleMessage без forceSend редактирует сообщение (default-параметр)', async () => {
      const ctx = makeCtx();
      const keyboard = new InlineKeyboard();

      await (service as any).sendScheduleMessage(ctx, 'txt', keyboard);

      expect(ctx.editMessageText).toHaveBeenCalledWith('txt', {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('не-владелец не может листать и снимать', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ config: { isOwner: false, user: {} }, match: [] });

      await handlers['^sched:p:(all|user|parser):(\\d+)$'](ctx);
      await handlers['^sched:off:(all|user|parser):(\\d+):(\\d+)$'](ctx);
      await handlers['^sched:offno:(all|user|parser):(\\d+):(\\d+)$'](ctx);
      await handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(4);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Только владелец');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(postSchedulerService.removeById).not.toHaveBeenCalled();
    });

    it('отсутствие config считается не-владельцем', async () => {
      const handlers = callbacks();
      const ctx = makeCtx({ config: undefined, match: [] });

      await handlers['^sched:p:(all|user|parser):(\\d+)$'](ctx);
      await handlers['^sched:off:(all|user|parser):(\\d+):(\\d+)$'](ctx);
      await handlers['^sched:offno:(all|user|parser):(\\d+):(\\d+)$'](ctx);
      await handlers['^sched:offok:(all|user|parser):(\\d+):(\\d+)$'](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Только владелец');
      expect(postSchedulerService.removeById).not.toHaveBeenCalled();
    });
  });

  describe('moderators-list', () => {
    it('показывает модераторов и ведёт в управление', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      userService.getModerators.mockResolvedValue([
        { id: 1, username: 'mod1' },
        { id: 2, username: 'mod2' },
      ]);

      const listMenu = menu.at('moderators-list');
      const kb = await rawKeyboard(listMenu, ctx);
      expect(await Promise.all(kb.map((r) => buttonText(r[0], ctx)))).toEqual([
        '@mod1',
        '@mod2',
        'Назад',
      ]);

      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(ctx.session.lastChangedModeratorId).toBe(1);
      expect(ctx.menu.nav).toHaveBeenCalledWith('moderator-manage');
    });

    it('пустой список показывает заглушку и возвращает в админ-меню', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      userService.getModerators.mockResolvedValue([]);

      const listMenu = menu.at('moderators-list');
      const kb = await rawKeyboard(listMenu, ctx);
      expect(await buttonText(kb[0][0], ctx)).toBe('Список пуст');

      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith(AdminMenusEnum.ADMIN_START_MENU);
    });
  });

  describe('moderator-manage', () => {
    it('исключение модератора снимает права и банит в канале', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      ctx.session.lastChangedModeratorId = 7;

      const manageMenu = menu.at('moderator-manage');
      const kb = await rawKeyboard(manageMenu, ctx);
      await kb[0][0].middleware[0](ctx, jest.fn());

      expect(userService.repository.update).toHaveBeenCalledWith({ id: 7 }, { isModerator: false });
      expect(ctx.api.banChatMember).toHaveBeenCalledWith(
        baseConfigService.userRequestMemeChannel,
        7
      );
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(7, expect.stringContaining('исключен'));
      expect(ctx.session.lastChangedModeratorId).toBeUndefined();
      expect(ctx.menu.nav).toHaveBeenCalledWith('moderators-list');
    });

    it('переключатели прав: обе подписи и инверсия значения', async () => {
      const { menu } = buildAdmin();
      const manageMenu = menu.at('moderator-manage');
      const ctx = makeCtx();

      for (const perm of PERMISSIONS) {
        ctx.session.lastChangedModeratorId = 9;
        const kb = await rawKeyboard(manageMenu, ctx);
        const btn = kb[perm.row][0];

        userService.findById.mockResolvedValue({ [perm.field]: true });
        expect(await buttonText(btn, ctx)).toBe(perm.yes);
        userService.findById.mockResolvedValue({ [perm.field]: false });
        expect(await buttonText(btn, ctx)).toBe(perm.no);

        userService.findById.mockResolvedValue({ [perm.field]: true });
        userService.repository.update.mockClear();
        ctx.menu.update.mockClear();
        await btn.middleware[0](ctx, jest.fn());
        expect(userService.repository.update).toHaveBeenCalledWith(
          { id: 9 },
          { [perm.field]: false }
        );
        expect(ctx.menu.update).toHaveBeenCalled();
      }
    });

    it('кнопка "Назад" возвращает к списку модераторов', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const manageMenu = menu.at('moderator-manage');
      const kb = await rawKeyboard(manageMenu, ctx);
      await kb[6][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith('moderators-list');
    });
  });

  describe('meme-limit', () => {
    it('меню лимита: выбор пользователя и назад', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const controlMenu = menu.at('meme-limit-control');
      const kb = await rawKeyboard(controlMenu, ctx);

      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(ctx.session.memeLimitControlState).toBe('select-user');
      expect(ctx.menu.nav).toHaveBeenCalledWith('meme-limit-select-user');

      await kb[1][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.back).toHaveBeenCalled();
    });

    it('список пользователей: строки и переход к опциям', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      userService.repository.find.mockResolvedValue([
        { id: 1, username: 'u1' },
        { id: 2, username: 'u2' },
      ]);
      const selectMenu = menu.at('meme-limit-select-user');
      const kb = await rawKeyboard(selectMenu, ctx);

      expect(userService.repository.find).toHaveBeenCalledWith({
        where: { isBanned: false },
        order: { lastActivity: 'DESC' },
        take: 50,
      });
      expect(kb.map((r) => r[0].text)).toEqual(['@u1', '@u2', 'Назад']);

      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(ctx.session.memeLimitUserId).toBe(1);
      expect(ctx.menu.nav).toHaveBeenCalledWith('meme-limit-options');

      await kb[2][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.back).toHaveBeenCalled();
    });

    it('список пуст: только кнопка назад', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      userService.repository.find.mockResolvedValue([]);
      const selectMenu = menu.at('meme-limit-select-user');
      const kb = await rawKeyboard(selectMenu, ctx);
      expect(kb).toHaveLength(1);
      expect(kb[0][0].text).toBe('Назад');
    });

    it('снятие лимита на 24 часа и 1 час', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      ctx.session.memeLimitUserId = 11;
      const optionsMenu = menu.at('meme-limit-options');
      const kb = await rawKeyboard(optionsMenu, ctx);

      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(userService.disableMemeLimitForUser).toHaveBeenCalledWith(11, 24);
      expect(ctx.reply).toHaveBeenCalledWith('Лимит мемов снят для пользователя на 24 часа');
      expect(ctx.menu.nav).toHaveBeenCalledWith(AdminMenusEnum.ADMIN_START_MENU);

      await kb[1][0].middleware[0](ctx, jest.fn());
      expect(userService.disableMemeLimitForUser).toHaveBeenCalledWith(11, 1);
      expect(ctx.reply).toHaveBeenCalledWith('Лимит мемов снят для пользователя на 1 час');

      await kb[2][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.back).toHaveBeenCalled();
    });
  });

  describe('troll-settings', () => {
    it('подписи отражают состояние и покрывают ветки форматирования', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const settingsMenu = menu.at(AdminMenusEnum.TROLL_SETTINGS_MENU);

      trollSettings.current = settingsBase();
      let kb = await rawKeyboard(settingsMenu, ctx);
      for (const row of kb) for (const btn of row) if (typeof btn.text === 'function') await btn.text(ctx);

      expect(await buttonText(kb[0][0], ctx)).toBe('Бот: 🟢 включён');
      expect(await buttonText(kb[2][0], ctx)).toBe('Порог статьи: 50%');
      expect(await buttonText(kb[4][0], ctx)).toBe('Пауза анализа УК: 10 с');
      expect(await buttonText(kb[7][0], ctx)).toBe('Пауза сарказма: 5 мин');
      expect(await buttonText(kb[25][0], ctx)).toContain('DeepSeek');
      expect(await buttonText(kb[25][0], ctx)).not.toContain('(пик)');

      deepSeek.usage.peak = true;
      deepSeek.usage.costUsd = 0.00005;
      trollSettings.current = {
        ...settingsBase(),
        enabled: false,
        criminalEnabled: false,
        sarcasmEnabled: false,
        mirrorEnabled: false,
        reactionEnabled: false,
        jerkEnabled: false,
        addressReactionEnabled: false,
        memeAnnounceEnabled: false,
        selfCheckEnabled: false,
        // значения вне пресетов и граничные длительности
        criminalThreshold: 0.55,
        criminalHighThreshold: 0.75,
        sarcasmChance: 0.07,
        mirrorChance: 0.12,
        reactionChance: 0.02,
        memeAnnounceChance: 0.15,
        selfCheckThreshold: 0.65,
        analyzeCooldownSec: 0,
        sarcasmCooldownSec: 3600,
        mirrorCooldownSec: 30,
        reactionCooldownSec: 3599,
        jerkBatchWindowSec: 0,
        jerkCooldownSec: 0,
        dialogPauseMin: 0,
      };
      kb = await rawKeyboard(settingsMenu, ctx);
      for (const row of kb) for (const btn of row) if (typeof btn.text === 'function') await btn.text(ctx);

      expect(await buttonText(kb[0][0], ctx)).toBe('Бот: ⚪️ выключен');
      expect(await buttonText(kb[4][0], ctx)).toBe('Пауза анализа УК: без паузы');
      expect(await buttonText(kb[7][0], ctx)).toBe('Пауза сарказма: 1 ч');
      expect(await buttonText(kb[10][0], ctx)).toBe('Пауза кривляния: 30 с');
      expect(await buttonText(kb[25][0], ctx)).toContain('(пик)');
      expect(await buttonText(kb[25][0], ctx)).toContain('< $0.0001');
    });

    it('все переключатели и циклы обновляют настройки', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const settingsMenu = menu.at(AdminMenusEnum.TROLL_SETTINGS_MENU);
      trollSettings.current = settingsBase();
      const kb = await rawKeyboard(settingsMenu, ctx);

      for (const row of TROLL_ROWS) {
        const btn = kb[row.row][0];
        if (row.type === 'toggle') {
          trollSettings.current[row.field] = true;
          trollSettings.update.mockClear();
          ctx.menu.update.mockClear();
          await btn.middleware[0](ctx, jest.fn());
          expect(trollSettings.update).toHaveBeenCalledWith({ [row.field]: false });
          expect(ctx.menu.update).toHaveBeenCalled();

          trollSettings.current[row.field] = false;
          trollSettings.update.mockClear();
          await btn.middleware[0](ctx, jest.fn());
          expect(trollSettings.update).toHaveBeenCalledWith({ [row.field]: true });
        } else {
          trollSettings.current[row.field] = row.presets![0];
          trollSettings.update.mockClear();
          ctx.menu.update.mockClear();
          await btn.middleware[0](ctx, jest.fn());
          expect(trollSettings.update).toHaveBeenCalledWith({ [row.field]: row.presets![1] });
          expect(ctx.menu.update).toHaveBeenCalled();
        }
      }

      await kb[25][0].middleware[0](ctx, jest.fn());
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Обновлено');

      await kb[26][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith(AdminMenusEnum.TROLL_CHATS_MENU);

      trollSettings.reset.mockClear();
      await kb[27][0].middleware[0](ctx, jest.fn());
      expect(trollSettings.reset).toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Настройки сброшены');

      await kb[28][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.back).toHaveBeenCalled();
    });

    it('cycle: для значения вне пресетов берёт ближайший и следующий за ним', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const settingsMenu = menu.at(AdminMenusEnum.TROLL_SETTINGS_MENU);
      // 0.42 не совпадает с пресетами, ближайший — 0.4, следующий — 0.5
      trollSettings.current = { ...settingsBase(), criminalThreshold: 0.42 };
      const kb = await rawKeyboard(settingsMenu, ctx);

      await kb[2][0].middleware[0](ctx, jest.fn());

      expect(trollSettings.update).toHaveBeenCalledWith({ criminalThreshold: 0.5 });
    });
  });

  describe('troll-chats', () => {
    it('пустой список чатов', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      trollService.getAllChats.mockResolvedValue([]);
      const chatsMenu = menu.at(AdminMenusEnum.TROLL_CHATS_MENU);
      const kb = await rawKeyboard(chatsMenu, ctx);

      expect(kb[0][0].text).toBe('Чатов пока нет');
      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith(AdminMenusEnum.TROLL_SETTINGS_MENU);
    });

    it('список чатов: emoji состояния и переключение активности', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      trollService.getAllChats.mockResolvedValue([
        { chatId: 1, title: 'Чат', isActive: true },
        { chatId: 2, title: null, isActive: false },
      ]);
      const chatsMenu = menu.at(AdminMenusEnum.TROLL_CHATS_MENU);
      const kb = await rawKeyboard(chatsMenu, ctx);

      expect(kb[0][0].text).toBe('🟢 Чат');
      expect(kb[1][0].text).toBe('⚪️ 2');
      expect(kb[2][0].text).toBe('Назад');

      await kb[0][0].middleware[0](ctx, jest.fn());
      expect(trollService.setChatActive).toHaveBeenCalledWith(1, false);
      expect(ctx.menu.update).toHaveBeenCalled();

      await kb[2][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.back).toHaveBeenCalled();
    });

    it('длинное название обрезается до 30 символов, берутся только 40 чатов', async () => {
      const { menu } = buildAdmin();
      const ctx = makeCtx();
      const chats = Array.from({ length: 45 }, (_, i) => ({
        chatId: i + 1,
        title: 'Очень длинное название чата номер ' + i,
        isActive: false,
      }));
      trollService.getAllChats.mockResolvedValue(chats);
      const chatsMenu = menu.at(AdminMenusEnum.TROLL_CHATS_MENU);
      const kb = await rawKeyboard(chatsMenu, ctx);
      const labels = kb.map((r) => r[0].text).filter((t) => t !== 'Назад');
      expect(labels).toHaveLength(40);
      expect(labels[0].length).toBeLessThanOrEqual('⚪️ '.length + 30);
    });
  });

  describe('addModeratorConversation', () => {
    function makeConversation(messages: any[]): any {
      let i = 0;
      return {
        wait: jest.fn(async () => messages[i++]),
        external: jest.fn(async (fn: any) => fn()),
      };
    }

    it('пропускает пустые, отсеивает модератора и бан, добавляет валидного', async () => {
      const ctx = makeCtx();
      const conv = makeConversation([
        { message: {} },
        { message: { text: 'already' } },
        { message: { text: 'banned' } },
        { message: { text: 'target' } },
      ]);
      userService.repository.findOne
        .mockResolvedValueOnce({ id: 2, username: 'already', isModerator: true })
        .mockResolvedValueOnce({ id: 3, username: 'banned', isBanned: true })
        .mockResolvedValueOnce({ id: 7, username: 'target' });

      await service.addModeratorConversation(conv, ctx);

      expect(userService.repository.findOne).toHaveBeenCalledTimes(3);
      expect(ctx.api.createChatInviteLink).toHaveBeenCalledWith(
        baseConfigService.userRequestMemeChannel,
        {
          member_limit: 1,
          name: 'moderator: target',
          expire_date: expect.any(Number),
        }
      );
      expect(userService.repository.update).toHaveBeenCalledWith({ id: 7 }, { isModerator: true });
      expect(ctx.api.getChat).toHaveBeenCalledWith(baseConfigService.memeChanelId);
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        7,
        expect.stringContaining('Канал мемов')
      );
    });

    it('неизвестный пользователь получает подсказку, /cancel завершает', async () => {
      const ctx = makeCtx();
      const conv = makeConversation([
        { message: { text: 'nobody' } },
        { message: { text: '/cancel' } },
      ]);
      userService.repository.findOne.mockResolvedValue(undefined);

      await service.addModeratorConversation(conv, ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Не нашли такого пользователя')
      );
      expect(ctx.reply).toHaveBeenCalledWith('Закончили искать модератора');
    });

    it('/cancel завершает диалог до проверки существования', async () => {
      const ctx = makeCtx();
      const conv = makeConversation([{ message: { text: '/cancel' } }]);
      userService.repository.findOne.mockResolvedValue(undefined);
      await service.addModeratorConversation(conv, ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Закончили искать модератора');
      expect(ctx.api.createChatInviteLink).not.toHaveBeenCalled();
    });
  });

  describe('year results', () => {
    it('showYearResults: предпросмотр с пользователями', async () => {
      const ctx = makeCtx();
      const preview = {
        general: { year: 2026 },
        users: [
          { userId: 1, username: 'u' },
          { userId: 2, username: 'v' },
        ],
      };
      yearResultsService.generateYearResults.mockResolvedValue(preview);
      yearResultsService.formatGeneralStatistics.mockReturnValue('GEN');
      const spy = jest
        .spyOn(service as any, 'sendUserDetailWithNavigation')
        .mockResolvedValue(undefined);

      await (service as any).showYearResults(ctx);

      expect(yearResultsService.generateYearResults).toHaveBeenCalledWith(new Date().getFullYear());
      expect(ctx.reply).toHaveBeenCalledWith('Генерирую итоги года...');
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('GEN'), { parse_mode: 'HTML' });
      expect(ctx.session.yearResultsPreview).toBe(preview);
      expect(ctx.session.yearResultsCurrentUserIndex).toBe(0);
      expect(spy).toHaveBeenCalledWith(ctx, preview, 0);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Итоги года'),
        { parse_mode: 'HTML' }
      );
    });

    it('showYearResults: без пользователей не отправляет персональные', async () => {
      const ctx = makeCtx();
      const preview = { general: { year: 2026 }, users: [] };
      yearResultsService.generateYearResults.mockResolvedValue(preview);
      const spy = jest.spyOn(service as any, 'sendUserDetailWithNavigation');

      await (service as any).showYearResults(ctx);

      expect(spy).not.toHaveBeenCalled();
    });

    it('showYearResults: ошибка логируется и сообщается пользователю', async () => {
      const ctx = makeCtx();
      yearResultsService.generateYearResults.mockRejectedValue(new Error('boom'));
      const errSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined as any);

      await (service as any).showYearResults(ctx);

      expect(errSpy).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Произошла ошибка при генерации итогов года');
    });

    it('sendUserDetailWithNavigation: строит клавиатуру и считает процентиль', async () => {
      const ctx = makeCtx({ match: [] });
      const preview = {
        general: { year: 2026 },
        users: [
          { userId: 1, username: 'alpha' },
          { userId: 2, username: null, firstName: 'Иван', lastName: 'Петров' },
          { userId: 3, firstName: 'Без', lastName: null },
        ],
      };
      yearResultsService.yearResultRepository.find.mockResolvedValue([
        { userId: 3, totalPublished: 30 },
        { userId: 1, totalPublished: 20 },
        { userId: 2, totalPublished: 10 },
      ]);
      yearResultsService.formatPersonalMessage.mockReturnValue('PERSONAL');

      await (service as any).sendUserDetailWithNavigation(ctx, preview, 1);

      expect(yearResultsService.yearResultRepository.find).toHaveBeenCalledWith({
        where: { year: 2026 },
        order: { totalPublished: 'DESC' },
      });
      // позиция 3 из 3 => процентиль = round((3-3+1)/3*100) = 33
      expect(yearResultsService.formatPersonalMessage).toHaveBeenCalledWith(
        preview.users[1],
        2026,
        33,
        3
      );
      const [text, opts] = ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1];
      expect(text).toContain('Иван Петров');
      expect(opts.parse_mode).toBe('HTML');
      const buttons = opts.reply_markup.inline_keyboard;
      expect(buttons[0].map((b: any) => b.text)).toEqual([
        '⬅️ Предыдущий',
        '2/3',
        'Следующий ➡️',
      ]);
    });

    it('sendUserDetailWithNavigation: крайние позиции скрывают лишние кнопки', async () => {
      const ctx = makeCtx();
      const preview = {
        general: { year: 2026 },
        users: [{ userId: 1, username: 'alpha' }],
      };
      yearResultsService.yearResultRepository.find.mockResolvedValue([
        { userId: 1, totalPublished: 5 },
      ]);

      await (service as any).sendUserDetailWithNavigation(ctx, preview, 0);
      const opts = ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1][1];
      const texts = opts.reply_markup.inline_keyboard[0].map((b: any) => b.text);
      expect(texts).toEqual(['1/1']);
      expect((service as any).formatUserName({ username: 'alpha' })).toBe('@alpha');
      expect((service as any).formatUserName({ firstName: 'A', lastName: 'B' })).toBe('A B');
      expect((service as any).formatUserName({ firstName: 'A', lastName: null })).toBe('A');
    });

    it('обработчики навигации по персональным сообщениям', async () => {
      const ctx = makeCtx();
      const preview = {
        general: { year: 2026 },
        users: [
          { userId: 1, username: 'a' },
          { userId: 2, username: 'b' },
        ],
      };
      ctx.session.yearResultsPreview = preview;
      yearResultsService.yearResultRepository.find.mockResolvedValue([
        { userId: 1, totalPublished: 2 },
        { userId: 2, totalPublished: 1 },
      ]);

      await (service as any).sendUserDetailWithNavigation(ctx, preview, 1);

      const callFor = (source: string) =>
        bot.callbackQuery.mock.calls.find(
          (c: any[]) => c[0] instanceof RegExp && c[0].source === source
        )[1];
      const callForString = (trigger: string) =>
        bot.callbackQuery.mock.calls.find((c: any[]) => c[0] === trigger)[1];

      const prevHandler = callFor('year_user_prev_(\\d+)');
      ctx.match = ['year_user_prev_1', '1'];
      ctx.reply.mockClear();
      await prevHandler(ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalled();
      const prevReply = ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1];
      expect(prevReply[0]).toContain('a');

      const nextHandler = callFor('year_user_next_(\\d+)');
      ctx.match = ['year_user_next_0', '0'];
      await nextHandler(ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();

      const countHandler = callForString('year_user_count');
      await countHandler(ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    it('publishYearResults: публикует общую и персональную статистику', async () => {
      const ctx = makeCtx();
      await (service as any).publishYearResults(ctx);
      expect(yearResultsService.publishGeneralStatistics).toHaveBeenCalledWith(
        new Date().getFullYear()
      );
      expect(yearResultsService.publishPersonalStatistics).toHaveBeenCalledWith(
        new Date().getFullYear()
      );
      expect(ctx.reply).toHaveBeenCalledWith('🎉 Итоги года успешно опубликованы!');
    });

    it('publishYearResults: ошибка логируется и сообщается пользователю', async () => {
      const ctx = makeCtx();
      yearResultsService.publishGeneralStatistics.mockRejectedValue(new Error('x'));
      const errSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined as any);
      await (service as any).publishYearResults(ctx);
      expect(errSpy).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Произошла ошибка при публикации итогов года');
    });
  });
});
