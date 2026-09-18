import { Menu, MenuRange } from '@grammyjs/menu';

// axios — ESM и не парсится jest; AdminMenuService тянет DeepSeekService транзитивно.
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ post: jest.fn() })) },
  isAxiosError: () => false,
}));

import { MainMenuService } from './main-menu.service';
import { UserMenusEnum } from './constants/bot-menus.enum';

function opsOf(obj: any): any[] | undefined {
  if (!obj) return undefined;
  const sym = Object.getOwnPropertySymbols(obj).find((s) =>
    String(s).includes('menu building')
  );
  return sym ? obj[sym] : undefined;
}

async function rawKeyboard(container: any, ctx: any): Promise<any[][]> {
  async function layout(keyboard: Promise<any[][]>, range: any): Promise<any[][]> {
    const k = await keyboard;
    const btns = typeof range === 'function' ? await range(ctx) : range;
    if (btns instanceof MenuRange) {
      let acc: Promise<any[][]> = Promise.resolve(k);
      for (const inner of opsOf(btns) ?? []) acc = layout(acc, inner);
      return acc;
    }
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

function makeCtx(overrides: any = {}): any {
  return {
    config: { isOwner: false, user: { isModerator: false } },
    session: { canBeModeratePosts: true },
    from: { id: 321 },
    reply: jest.fn().mockResolvedValue({}),
    menu: { nav: jest.fn(), update: jest.fn(), back: jest.fn() },
    ...overrides,
  };
}

describe('MainMenuService', () => {
  let service: MainMenuService;
  let bot: any;
  let adminMenuService: any;
  let moderatorStartMenuService: any;
  let userService: any;
  let adminMenu: Menu<any>;
  let moderatorMenu: Menu<any>;

  beforeEach(() => {
    adminMenu = new Menu<any>('admin-start');
    moderatorMenu = new Menu<any>('moderator-start');
    bot = { use: jest.fn() };
    adminMenuService = { buildStartAdminMenu: jest.fn().mockReturnValue(adminMenu) };
    moderatorStartMenuService = {
      buildStartModeratorMenu: jest.fn().mockReturnValue(moderatorMenu),
    };
    userService = { changeUserModeratedMode: jest.fn().mockResolvedValue(undefined) };
    service = new MainMenuService(bot, adminMenuService, moderatorStartMenuService, userService);
  });

  it('содержит текст правил публикации', () => {
    expect(service.MEME_RULES).toContain('Для публикации принимаются');
    expect(service.MEME_RULES).toContain('Требования законодательства РФ');
  });

  it('initStartMenu строит меню и подключает их к боту', () => {
    service.initStartMenu();

    expect(moderatorStartMenuService.buildStartModeratorMenu).toHaveBeenCalledTimes(1);
    expect(adminMenuService.buildStartAdminMenu).toHaveBeenCalledTimes(1);

    const userMenu = service['userStartMenu'];
    expect(userMenu).toBeInstanceOf(Menu);
    expect(moderatorStartMenuService.buildStartModeratorMenu).toHaveBeenCalledWith(userMenu);
    expect(adminMenuService.buildStartAdminMenu).toHaveBeenCalledWith(userMenu, moderatorMenu);

    expect(bot.use).toHaveBeenCalledTimes(3);
    expect(bot.use).toHaveBeenNthCalledWith(1, userMenu);
    expect(bot.use).toHaveBeenNthCalledWith(2, moderatorMenu);
    expect(bot.use).toHaveBeenNthCalledWith(3, adminMenu);
  });

  describe('getRoleBasedStartMenu', () => {
    beforeEach(() => service.initStartMenu());

    it('владельцу отдаёт админ-меню', () => {
      expect(
        service.getRoleBasedStartMenu({
          config: { isOwner: true, user: { isModerator: false } },
        } as any)
      ).toBe(adminMenu);
    });

    it('модератору отдаёт меню модератора', () => {
      expect(
        service.getRoleBasedStartMenu({
          config: { isOwner: false, user: { isModerator: true } },
        } as any)
      ).toBe(moderatorMenu);
    });

    it('обычному пользователю отдаёт меню пользователя', () => {
      expect(
        service.getRoleBasedStartMenu({
          config: { isOwner: false, user: { isModerator: false } },
        } as any)
      ).toBe(service['userStartMenu']);
    });

    it('без данных пользователя отдаёт меню пользователя', () => {
      expect(
        service.getRoleBasedStartMenu({ config: { isOwner: false } } as any)
      ).toBe(service['userStartMenu']);
    });

    it('устойчиво к пропавшему config во время выбора роли', () => {
      let reads = 0;
      const ctx = {
        // первый случай читает конфиг, второй — уже нет: проверяем защитный `?.`
        get config() {
          reads += 1;
          return reads === 1 ? { isOwner: false, user: { isModerator: true } } : undefined;
        },
      } as any;
      expect(service.getRoleBasedStartMenu(ctx)).toBe(service['userStartMenu']);
    });
  });

  describe('пользовательское меню', () => {
    it('кнопка правил отправляет текст правил', async () => {
      service.initStartMenu();
      const ctx = makeCtx();
      const userMenu = service['userStartMenu'];
      const kb = await rawKeyboard(userMenu, ctx);

      await kb[0][0].middleware[0](ctx, jest.fn());

      expect(ctx.reply).toHaveBeenCalledWith(service.MEME_RULES, { parse_mode: 'HTML' });
    });

    it('кнопка связи с админом отправляет подсказку', async () => {
      service.initStartMenu();
      const ctx = makeCtx();
      const kb = await rawKeyboard(service['userStartMenu'], ctx);
      await kb[2][0].middleware[0](ctx, jest.fn());
      expect(ctx.reply).toHaveBeenCalledWith('Просто напиши сообщение, тебе ответят');
    });

    it('кнопка канала содержит внешнюю ссылку', async () => {
      service.initStartMenu();
      const ctx = makeCtx();
      const kb = await rawKeyboard(service['userStartMenu'], ctx);
      expect(kb[3][0].text).toBe('Перейти в канал');
      expect(kb[3][0].url).toBe('https://t.me/filipp_memes');
    });

    it('кнопка настроек открывает подменю', async () => {
      service.initStartMenu();
      const ctx = makeCtx();
      const kb = await rawKeyboard(service['userStartMenu'], ctx);
      await kb[1][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.nav).toHaveBeenCalledWith('main-settings-menu');
    });

    it('подменю настроек переключает режим оценивания', async () => {
      service.initStartMenu();
      const ctx = makeCtx();
      const settings = service['userStartMenu'].at('main-settings-menu');
      const kb = await rawKeyboard(settings, ctx);
      const toggle = kb[0][0];

      ctx.session.canBeModeratePosts = true;
      expect(await (toggle.text as any)(ctx)).toBe('👮 Оцениваю посты');
      ctx.session.canBeModeratePosts = false;
      expect(await (toggle.text as any)(ctx)).toBe('🙅 Не оцениваю посты');

      ctx.session.canBeModeratePosts = true;
      await toggle.middleware[0](ctx, jest.fn());
      expect(ctx.session.canBeModeratePosts).toBe(false);
      expect(userService.changeUserModeratedMode).toHaveBeenCalledWith(321, false);
      expect(ctx.menu.update).toHaveBeenCalled();

      await kb[1][0].middleware[0](ctx, jest.fn());
      expect(ctx.menu.back).toHaveBeenCalled();
    });

    it('меню пользователя зарегистрировано под ожидаемым идентификатором', () => {
      service.initStartMenu();
      expect(service['userStartMenu'].at(UserMenusEnum.USER_START_MENU)).toBe(
        service['userStartMenu']
      );
    });
  });
});
