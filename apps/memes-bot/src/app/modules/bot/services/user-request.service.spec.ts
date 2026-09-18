import * as dateFns from 'date-fns';
import { UserRequestService } from './user-request.service';

jest.mock('date-fns', () => {
  const actual = jest.requireActual('date-fns');
  return { ...actual, intervalToDuration: jest.fn(actual.intervalToDuration) };
});

function makeRepo(): any {
  return {
    findOne: jest.fn(),
    countBy: jest.fn(),
  };
}

function makeService(repo: any = makeRepo()) {
  return { service: new UserRequestService(repo), repo };
}

function callbackCtx(messageId = 55): any {
  return { callbackQuery: { message: { message_id: messageId } } };
}

/** findOne сначала отдаёт сообщение заявки, затем искомую запись. */
function stubMessageThen(repo: any, message: any, result: any) {
  repo.findOne.mockResolvedValueOnce(message).mockResolvedValueOnce(result);
}

describe('UserRequestService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('отдаёт переданный репозиторий через getter', () => {
    const { service, repo } = makeService();

    expect(service.repository).toBe(repo);
  });

  describe('lastPublishedPostTimeAgo', () => {
    it('возвращает «нет», если публикаций не было', async () => {
      const { service, repo } = makeService();
      stubMessageThen(repo, { user: { id: 11 } }, null);

      await expect(service.lastPublishedPostTimeAgo(callbackCtx())).resolves.toBe('нет');

      expect(repo.findOne).toHaveBeenNthCalledWith(1, {
        where: { userRequestChannelMessageId: 55 },
        relations: { user: true },
      });
      expect(repo.findOne).toHaveBeenNthCalledWith(2, {
        where: { user: { id: 11 }, isPublished: true },
        order: { publishedAt: 'DESC' },
      });
    });

    it.each([
      [new Date('2024-09-18T12:00:00Z'), '2 года'],
      [new Date('2026-07-18T12:00:00Z'), '2 месяца'],
      [new Date('2026-09-15T12:00:00Z'), '3 дня'],
      [new Date('2026-09-18T08:00:00Z'), '4 часа'],
      [new Date('2026-09-18T11:50:00Z'), '10 минут'],
    ])('описывает давность публикации %s как «%s»', async (publishedAt, expected) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-18T12:00:00Z'));
      const { service, repo } = makeService();
      stubMessageThen(repo, { user: { id: 1 } }, { publishedAt });

      await expect(service.lastPublishedPostTimeAgo(callbackCtx())).resolves.toBe(expected);
      jest.useRealTimers();
    });

    it('свежую публикацию помечает как «Только что»', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-18T12:00:00Z'));
      const { service, repo } = makeService();
      stubMessageThen(
        repo,
        { user: { id: 1 } },
        { publishedAt: new Date('2026-09-18T11:59:50Z') }
      );

      await expect(service.lastPublishedPostTimeAgo(callbackCtx())).resolves.toBe('Только что');
      jest.useRealTimers();
    });

    it('разбирает недели, если интервал их отдаёт', async () => {
      (dateFns.intervalToDuration as jest.Mock).mockReturnValueOnce({ weeks: 2 });
      const { service, repo } = makeService();
      stubMessageThen(repo, { user: { id: 1 } }, { publishedAt: new Date() });

      await expect(service.lastPublishedPostTimeAgo(callbackCtx())).resolves.toBe('2 недели');
    });

    it('возвращает undefined, если публикация только что без секунд', async () => {
      const { service, repo } = makeService();
      const now = new Date('2026-09-18T12:00:00Z');
      jest.useFakeTimers().setSystemTime(now);
      stubMessageThen(repo, { user: { id: 1 } }, { publishedAt: now });

      await expect(service.lastPublishedPostTimeAgo(callbackCtx())).resolves.toBeUndefined();
      jest.useRealTimers();
    });

    it('возвращает undefined, если интервал не удалось вычислить', async () => {
      (dateFns.intervalToDuration as jest.Mock).mockReturnValueOnce(null);
      const { service, repo } = makeService();
      stubMessageThen(repo, { user: { id: 1 } }, { publishedAt: new Date() });

      await expect(service.lastPublishedPostTimeAgo(callbackCtx())).resolves.toBeUndefined();
    });
  });

  describe('userPostApprovedStatistic', () => {
    it('считает всего и за сутки одобренные заявки', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ user: { id: 11 } });
      repo.countBy.mockResolvedValueOnce(8).mockResolvedValueOnce(3);

      await expect(service.userPostApprovedStatistic(callbackCtx())).resolves.toEqual({
        total: 8,
        day: 3,
      });
      expect(repo.countBy).toHaveBeenNthCalledWith(1, {
        user: { id: 11 },
        isPublished: true,
      });
      expect(repo.countBy).toHaveBeenNthCalledWith(2, {
        user: { id: 11 },
        isPublished: true,
        publishedAt: expect.anything(),
      });
    });

    it('нули подменяет на 0 через логическое ИЛИ', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ user: { id: 3 } });
      repo.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      await expect(service.userPostApprovedStatistic(callbackCtx())).resolves.toEqual({
        total: 0,
        day: 0,
      });
    });
  });

  describe('username', () => {
    it('отдаёт username автора заявки', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ user: { username: 'vasya' } });
      const ctx: any = { message: { message_id: 77 } };

      await expect(service.username(ctx)).resolves.toBe('vasya');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { userRequestChannelMessageId: 77 },
        relations: { user: true },
      });
    });
  });

  describe('userPostDiscardStatistic', () => {
    it('считает всего и за сутки отклонённые заявки', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ user: { id: 11 } });
      repo.countBy.mockResolvedValueOnce(5).mockResolvedValueOnce(1);

      await expect(service.userPostDiscardStatistic(callbackCtx())).resolves.toEqual({
        total: 5,
        week: 1,
      });
      expect(repo.countBy).toHaveBeenNthCalledWith(1, {
        user: { id: 11 },
        isApproved: false,
      });
      expect(repo.countBy).toHaveBeenNthCalledWith(2, {
        user: { id: 11 },
        isApproved: false,
        moderatedAt: expect.anything(),
      });
    });

    it('нули подменяет на 0 через логическое ИЛИ', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ user: { id: 11 } });
      repo.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      await expect(service.userPostDiscardStatistic(callbackCtx())).resolves.toEqual({
        total: 0,
        week: 0,
      });
    });
  });

  describe('countUserMemeRequestsLast24h', () => {
    it('считает только медиа-запросы за сутки', async () => {
      const { service, repo } = makeService();
      repo.countBy.mockResolvedValue(12);

      await expect(service.countUserMemeRequestsLast24h(11)).resolves.toBe(12);
      expect(repo.countBy).toHaveBeenCalledWith({
        user: { id: 11 },
        createdAt: expect.anything(),
        isTextRequest: false,
      });
    });

    it('ноль запросов отдаёт как 0', async () => {
      const { service, repo } = makeService();
      repo.countBy.mockResolvedValue(0);

      await expect(service.countUserMemeRequestsLast24h(11)).resolves.toBe(0);
    });
  });
});
