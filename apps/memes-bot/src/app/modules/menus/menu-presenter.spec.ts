import { MenuPresenter } from './menu-presenter';

describe('MenuPresenter', () => {
  let presenter: MenuPresenter;

  beforeEach(() => {
    presenter = new MenuPresenter();
  });

  const makeCtx = (overrides: any = {}): any => ({
    config: { isOwner: true },
    answerCallbackQuery: jest.fn().mockResolvedValue({}),
    reply: jest.fn().mockResolvedValue({}),
    ...overrides,
  });

  describe('ownerGuard', () => {
    it('владельцу передаёт управление обработчику', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const ctx = makeCtx();
      await presenter.ownerGuard(handler)(ctx);
      expect(handler).toHaveBeenCalledWith(ctx);
      expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    });

    it('не владельцу показывает отказ и не вызывает обработчик', async () => {
      const handler = jest.fn();
      const ctx = makeCtx({ config: { isOwner: false } });
      await presenter.ownerGuard(handler)(ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
      expect(handler).not.toHaveBeenCalled();
    });

    it('без config считает пользователя не владельцем', async () => {
      const handler = jest.fn();
      const ctx = makeCtx({ config: undefined });
      await presenter.ownerGuard(handler)(ctx);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Доступно только владельцу');
      expect(handler).not.toHaveBeenCalled();
    });

    it('глотает ошибку answerCallbackQuery', async () => {
      const ctx = makeCtx({
        config: { isOwner: false },
        answerCallbackQuery: jest.fn().mockRejectedValue(new Error('query too old')),
      });
      await expect(presenter.ownerGuard(jest.fn())(ctx)).resolves.toBeUndefined();
    });
  });

  describe('switchToMenu', () => {
    it('отправляет подсказку с клавиатурой меню', async () => {
      const menu: any = { id: 'some-menu' };
      const ctx = makeCtx();
      await presenter.switchToMenu(menu)(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Выбери то, что хочешь сделать', {
        reply_markup: menu,
      });
    });
  });
});
