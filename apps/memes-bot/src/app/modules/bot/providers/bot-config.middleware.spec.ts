import { BotConfigMiddleware } from './bot-config.middleware';

describe('BotConfigMiddleware', () => {
  function setup(ownerId = 100) {
    const baseConfigService = { ownerId } as any;
    const user = { id: 1, isBanned: false };
    const userService = { findById: jest.fn().mockResolvedValue(user) } as any;
    const middleware = new BotConfigMiddleware(baseConfigService, userService);
    return { middleware, baseConfigService, userService, user };
  }

  it('configMiddleware возвращает функцию-мидлварь', () => {
    const { middleware } = setup();
    expect(typeof middleware.configMiddleware()).toBe('function');
  });

  it('для владельца ставит isOwner=true и прокидывает найденного пользователя', async () => {
    const { middleware, userService, user } = setup(100);
    const ctx: any = { from: { id: 100 } };
    const next = jest.fn().mockResolvedValue(undefined);

    await (middleware.configMiddleware() as any)(ctx, next);

    expect(userService.findById).toHaveBeenCalledWith(100);
    expect(ctx.config).toEqual({ isOwner: true, user });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('для обычного пользователя ставит isOwner=false', async () => {
    const { middleware, userService, user } = setup(100);
    const ctx: any = { from: { id: 555 } };
    const next = jest.fn().mockResolvedValue(undefined);

    await (middleware.configMiddleware() as any)(ctx, next);

    expect(userService.findById).toHaveBeenCalledWith(555);
    expect(ctx.config).toEqual({ isOwner: false, user });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('переживает отсутствие ctx.from (optional chaining) и ищет пользователя по undefined', async () => {
    const { middleware, userService } = setup(100);
    const ctx: any = {};
    const next = jest.fn().mockResolvedValue(undefined);

    await (middleware.configMiddleware() as any)(ctx, next);

    expect(userService.findById).toHaveBeenCalledWith(undefined);
    expect(ctx.config.isOwner).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('пробрасывает undefined, если пользователь не найден', async () => {
    const { middleware, userService } = setup(100);
    userService.findById.mockResolvedValue(undefined);
    const ctx: any = { from: { id: 7 } };

    await (middleware.configMiddleware() as any)(ctx, jest.fn());

    expect(ctx.config.user).toBeUndefined();
  });
});
