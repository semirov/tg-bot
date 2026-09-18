import { Menu, MenuRange } from '@grammyjs/menu';
import { ModeratorMenuService } from './moderator-menu.service';
import { ModeratorMenusEnum } from './constants/bot-menus.enum';

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
    config: { isOwner: false, user: { id: 42, isModerator: true } },
    session: {},
    from: { id: 42 },
    reply: jest.fn().mockResolvedValue({}),
    menu: { nav: jest.fn(), update: jest.fn(), back: jest.fn() },
    ...overrides,
  };
}

describe('ModeratorMenuService', () => {
  let service: ModeratorMenuService;
  let bot: any;
  let userRequestService: any;

  beforeEach(() => {
    bot = { use: jest.fn() };
    userRequestService = { repository: { countBy: jest.fn() } };
    service = new ModeratorMenuService(bot, userRequestService);
  });

  it('строит стартовое меню с двумя кнопками', () => {
    const userStartMenu = new Menu<any>('user-start');
    const menu = service.buildStartModeratorMenu(userStartMenu);
    expect(menu).toBeInstanceOf(Menu);
  });

  it('кнопка "Меню пользователя" отдаёт пользовательскую клавиатуру', async () => {
    const userStartMenu = new Menu<any>('user-start');
    const menu = service.buildStartModeratorMenu(userStartMenu);
    const ctx = makeCtx();
    const kb = await rawKeyboard(menu, ctx);

    await kb[0][0].middleware[0](ctx, jest.fn());

    expect(ctx.reply).toHaveBeenCalledWith('Выбери то, что хочешь сделать', {
      reply_markup: userStartMenu,
    });
  });

  it('кнопка статистики считает одобренные и отклонённые посты', async () => {
    const userStartMenu = new Menu<any>('user-start');
    const menu = service.buildStartModeratorMenu(userStartMenu);
    const ctx = makeCtx();

    const counts = [100, 20, 5, 1, 30, 10, 3, 2];
    let call = 0;
    userRequestService.repository.countBy.mockImplementation(async () => counts[call++]);

    const kb = await rawKeyboard(menu, ctx);
    await kb[1][0].middleware[0](ctx, jest.fn());

    expect(userRequestService.repository.countBy).toHaveBeenCalledTimes(8);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('<b>Одобрено постов:</b>'),
      { parse_mode: 'HTML' }
    );
    const message = ctx.reply.mock.calls[0][0];
    expect(message).toContain('всего: 100');
    expect(message).toContain('за месяц: 20');
    expect(message).toContain('за неделю: 5');
    expect(message).toContain('за день: 1');
    expect(message).toContain('всего: 30');
    expect(message).toContain('за месяц: 10');
    expect(message).toContain('за неделю: 3');
    expect(message).toContain('за день: 2');
  });

  it('статистика фильтрует по текущему модератору', async () => {
    const userStartMenu = new Menu<any>('user-start');
    const menu = service.buildStartModeratorMenu(userStartMenu);
    const ctx = makeCtx({ config: { isOwner: false, user: { id: 777, isModerator: true } } });
    userRequestService.repository.countBy.mockResolvedValue(0);

    const kb = await rawKeyboard(menu, ctx);
    await kb[1][0].middleware[0](ctx, jest.fn());

    for (const call of userRequestService.repository.countBy.mock.calls) {
      expect(call[0].processedByModerator).toEqual({ id: 777 });
    }
    // первые четыре запроса — одобренные, следующие четыре — отклонённые
    expect(userRequestService.repository.countBy.mock.calls.slice(0, 4).every((c: any[]) => c[0].isApproved)).toBe(true);
    expect(userRequestService.repository.countBy.mock.calls.slice(4).every((c: any[]) => c[0].isApproved === false)).toBe(true);
  });
});
