import { ConsoleLogger } from '@nestjs/common';
import { UserPermissionEnum } from '../constants/user-permission.enum';
import { UserService } from './user.service';

function makeRepo(): any {
  return {
    update: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    upsert: jest.fn(),
  };
}

function makeService(repo: any = makeRepo()) {
  return { service: new UserService(repo), repo };
}

function makeCtx(overrides: Record<string, any> = {}): any {
  return {
    from: { id: 5, username: 'vasya', first_name: 'Вася', last_name: 'Пупкин', is_bot: false },
    config: { isOwner: false, user: undefined },
    api: { banChatMember: jest.fn(), sendMessage: jest.fn() },
    ...overrides,
  };
}

describe('UserService', () => {
  beforeEach(() => {
    jest.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('отдаёт переданный репозиторий через getter', () => {
    const { service, repo } = makeService();

    expect(service.repository).toBe(repo);
  });

  describe('changeUserModeratedMode', () => {
    it('обновляет флаг модерации по id', async () => {
      const { service, repo } = makeService();

      await service.changeUserModeratedMode(7, true);

      expect(repo.update).toHaveBeenCalledWith({ id: 7 }, { canBeModeratePosts: true });
    });
  });

  describe('findById', () => {
    it('ищет пользователя по id', async () => {
      const { service, repo } = makeService();
      const user = { id: 3 };
      repo.findOne.mockResolvedValue(user);

      await expect(service.findById(3)).resolves.toBe(user);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 3 } });
    });

    it('возвращает undefined, если пользователь не найден', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue(undefined);

      await expect(service.findById(9)).resolves.toBeUndefined();
    });
  });

  describe('getModerators', () => {
    it('берёт только активных модераторов', async () => {
      const { service, repo } = makeService();
      const moderators = [{ id: 1 }];
      repo.find.mockResolvedValue(moderators);

      await expect(service.getModerators()).resolves.toBe(moderators);
      expect(repo.find).toHaveBeenCalledWith({ where: { isModerator: true, isBanned: false } });
    });
  });

  describe('updateUserLastActivity', () => {
    it('делает upsert по данным из контекста и проставляет lastActivity', async () => {
      const { service, repo } = makeService();
      const insertResult = { identifiers: [{ id: 5 }] };
      repo.upsert.mockResolvedValue(insertResult);
      const ctx = makeCtx();

      await expect(service.updateUserLastActivity(ctx)).resolves.toBe(insertResult);

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      const [values, conflict] = repo.upsert.mock.calls[0];
      expect(values).toMatchObject({
        id: 5,
        username: 'vasya',
        firstName: 'Вася',
        lastName: 'Пупкин',
        isBot: false,
      });
      expect(values.lastActivity).toBeInstanceOf(Date);
      expect(conflict).toEqual(['id']);
    });
  });

  describe('disableMemeLimitForUser', () => {
    it('сдвигает лимит на указанное число часов и логирует успех', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
      const { service, repo } = makeService();
      repo.update.mockResolvedValue({ affected: 1 });
      const expected = new Date('2026-09-18T10:00:00.000Z');
      expected.setHours(expected.getHours() + 3);

      await service.disableMemeLimitForUser(42, 3);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 42 },
        { memeLimitDisabledUntil: expected }
      );
      expect(ConsoleLogger.prototype.log).toHaveBeenCalledWith(
        `Disabling meme limit for user 42 until ${expected}`,
        'UserService'
      );
      expect(ConsoleLogger.prototype.log).toHaveBeenCalledWith(
        'Successfully disabled meme limit for user 42',
        'UserService'
      );
      jest.useRealTimers();
    });

    it('предупреждает, если запись не обновилась', async () => {
      const { service, repo } = makeService();
      repo.update.mockResolvedValue({ affected: 0 });

      await service.disableMemeLimitForUser(42, 1);

      expect(ConsoleLogger.prototype.warn).toHaveBeenCalledWith(
        'No user found with id 42 when trying to disable meme limit',
        'UserService'
      );
    });

    it('при ошибке БД логирует и пробрасывает исключение', async () => {
      const { service, repo } = makeService();
      repo.update.mockRejectedValue(new Error('db down'));

      await expect(service.disableMemeLimitForUser(8, 2)).rejects.toThrow('db down');

      expect(ConsoleLogger.prototype.error).toHaveBeenCalledWith(
        'Failed to disable meme limit for user 8: db down',
        'UserService'
      );
    });
  });

  describe('isMemeLimitDisabled', () => {
    it('true, если срок отключения ещё не истёк', async () => {
      const { service, repo } = makeService();
      const future = new Date(Date.now() + 60_000);
      repo.findOneBy.mockResolvedValue({ id: 1, memeLimitDisabledUntil: future });

      await expect(service.isMemeLimitDisabled(1)).resolves.toBe(true);
      expect(repo.findOneBy).toHaveBeenCalledWith({ id: 1 });
    });

    it('false, если срок отключения уже прошёл', async () => {
      const { service, repo } = makeService();
      repo.findOneBy.mockResolvedValue({
        id: 1,
        memeLimitDisabledUntil: new Date(Date.now() - 60_000),
      });

      await expect(service.isMemeLimitDisabled(1)).resolves.toBe(false);
    });

    it('false, если лимит никогда не отключали', async () => {
      const { service, repo } = makeService();
      repo.findOneBy.mockResolvedValue({ id: 1, memeLimitDisabledUntil: null });

      await expect(service.isMemeLimitDisabled(1)).resolves.toBe(false);
      expect(ConsoleLogger.prototype.log).toHaveBeenCalledWith(
        'Meme limit for user 1 is enabled (until null)',
        'UserService'
      );
    });

    it('false и предупреждение, если пользователь не найден', async () => {
      const { service, repo } = makeService();
      repo.findOneBy.mockResolvedValue(undefined);

      await expect(service.isMemeLimitDisabled(99)).resolves.toBe(false);
      expect(ConsoleLogger.prototype.warn).toHaveBeenCalledWith(
        'User with id 99 not found when checking meme limit status',
        'UserService'
      );
    });

    it('false при ошибке чтения', async () => {
      const { service, repo } = makeService();
      repo.findOneBy.mockRejectedValue(new Error('read fail'));

      await expect(service.isMemeLimitDisabled(5)).resolves.toBe(false);
      expect(ConsoleLogger.prototype.error).toHaveBeenCalledWith(
        'Error checking meme limit status for user 5: read fail',
        'UserService'
      );
    });
  });

  describe('getUsersForPostModerate', () => {
    it('выбирает только id активных и сортирует по последней активности', async () => {
      const { service, repo } = makeService();
      const rows = [{ id: 1 }, { id: 2 }];
      repo.find.mockResolvedValue(rows);

      await expect(service.getUsersForPostModerate()).resolves.toBe(rows);
      expect(repo.find).toHaveBeenCalledWith({
        select: { id: true },
        where: { canBeModeratePosts: true, isBanned: false },
        order: { lastActivity: 'DESC' },
      });
    });
  });

  describe('checkPermission', () => {
    it('владелец проходит любую проверку', () => {
      const { service } = makeService();
      const ctx = makeCtx({ config: { isOwner: true, user: undefined } });

      expect(service.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)).toBe(true);
    });

    it('не модератор без callback получает отказ', () => {
      const { service } = makeService();
      const ctx = makeCtx({ config: { isOwner: false, user: { isModerator: false } } });

      expect(service.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)).toBe(false);
      expect(ctx.api.banChatMember).not.toHaveBeenCalled();
    });

    it('отсутствующий пользователь тоже получает отказ', () => {
      const { service } = makeService();
      const ctx = makeCtx({ config: { isOwner: false, user: undefined } });

      expect(service.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)).toBe(false);
      expect(ctx.api.banChatMember).not.toHaveBeenCalled();
    });

    it('переживает пропавший config между проверками', () => {
      const { service } = makeService();
      let reads = 0;
      const ctx: any = {
        get config() {
          reads += 1;
          return reads === 1 ? { isOwner: false } : undefined;
        },
        api: { banChatMember: jest.fn() },
      };

      expect(service.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)).toBe(false);
      expect(reads).toBe(2);
      expect(ctx.api.banChatMember).not.toHaveBeenCalled();
    });

    it('не модератор с callback банится в чате', () => {
      const { service } = makeService();
      const ctx = makeCtx({
        config: { isOwner: false, user: { isModerator: false } },
        callbackQuery: { message: { chat: { id: -100 }, message_id: 10 }, from: { id: 77 } },
      });

      expect(service.checkPermission(ctx, UserPermissionEnum.IS_BASE_MODERATOR)).toBe(false);
      expect(ctx.api.banChatMember).toHaveBeenCalledWith(-100, 77);
    });

    it.each([
      [UserPermissionEnum.IS_BASE_MODERATOR, 'isModerator'],
      [UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL, 'allowPublishToChannel'],
      [UserPermissionEnum.ALLOW_DELETE_REJECTED_POST, 'allowDeleteRejectedPost'],
      [UserPermissionEnum.ALLOW_RESTORE_DISCARDED_POST, 'allowRestoreDiscardedPost'],
      [UserPermissionEnum.ALLOW_SET_STRIKE, 'allowSetStrike'],
      [UserPermissionEnum.ALLOW_MAKE_BAN, 'allowMakeBan'],
    ])('модератору разрешает %s по флагу %s', (permission, flag) => {
      const { service } = makeService();
      const user = { isModerator: true, [flag]: true };
      const ctx = makeCtx({ config: { isOwner: false, user } });

      expect(service.checkPermission(ctx, permission)).toBe(true);
    });

    it('модератору запрещает, если конкретный флаг выключен', () => {
      const { service } = makeService();
      const ctx = makeCtx({
        config: { isOwner: false, user: { isModerator: true, allowMakeBan: false } },
      });

      expect(service.checkPermission(ctx, UserPermissionEnum.ALLOW_MAKE_BAN)).toBe(false);
    });

    it('на неизвестное право отвечает callback-предупреждением', () => {
      const { service } = makeService();
      const answerCallbackQuery = jest.fn();
      const ctx = makeCtx({
        config: { isOwner: false, user: { isModerator: true } },
        callbackQuery: { message: { chat: { id: -1 }, message_id: 1 }, from: { id: 2 } },
        answerCallbackQuery,
      });

      expect(
        service.checkPermission(ctx, 'SOMETHING_ELSE' as UserPermissionEnum)
      ).toBeUndefined();
      expect(answerCallbackQuery).toHaveBeenCalledWith(
        'У тебя нет прав, чтобы нажимать эту кнопку'
      );
    });

    it('на неизвестное право без callback просто ничего не делает', () => {
      const { service } = makeService();
      const ctx = makeCtx({
        config: { isOwner: false, user: { isModerator: true } },
      });

      expect(
        service.checkPermission(ctx, 'SOMETHING_ELSE' as UserPermissionEnum)
      ).toBeUndefined();
    });
  });
});
