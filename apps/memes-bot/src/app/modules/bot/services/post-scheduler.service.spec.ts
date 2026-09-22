import { PostSchedulerService } from './post-scheduler.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';

const msk = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 3, mi));

function setup() {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation((value) => value),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  } as any;
  const service = new PostSchedulerService(repo);
  return { service, repo };
}

function withNow(date: Date) {
  jest.useFakeTimers();
  jest.setSystemTime(date);
}

const baseContext = {
  mode: PublicationModesEnum.NEXT_MIDDAY,
  requestChannelMessageId: 5,
  processedByModerator: 9,
  caption: 'cap',
  isUserPost: true,
  hash: 'h',
};

describe('PostSchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('repository', () => {
    it('геттер отдаёт переданный репозиторий', () => {
      const { service, repo } = setup();
      expect(service.repository).toBe(repo);
    });
  });

  describe('nextScheduledPost', () => {
    it('ищет ближайший неопубликованный пост с модератором', async () => {
      const { service, repo } = setup();
      const post = { id: 1 };
      repo.findOne.mockResolvedValue(post);

      await expect(service.nextScheduledPost()).resolves.toBe(post);
      expect(repo.findOne).toHaveBeenCalledWith({
        relations: { processedByModerator: true },
        where: { publishDate: expect.anything(), isPublished: false },
        order: { publishDate: 'DESC' },
      });
      const arg = repo.findOne.mock.calls[0][0];
      expect(arg.where.publishDate.value).toBeInstanceOf(Date);
    });
  });

  describe('nowIsMode', () => {
    it('true, когда московское время внутри окна режима', () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 15, 0));
      expect(service.nowIsMode(PublicationModesEnum.NEXT_MIDDAY)).toBe(true);
    });

    it('false, когда время вне окна', () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 9, 0));
      expect(service.nowIsMode(PublicationModesEnum.NEXT_MIDDAY)).toBe(false);
    });

    it('учитывает границы включительно', () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 13, 0));
      expect(service.nowIsMode(PublicationModesEnum.NEXT_MIDDAY)).toBe(true);
      withNow(msk(2026, 1, 15, 19, 0));
      expect(service.nowIsMode(PublicationModesEnum.NEXT_MIDDAY)).toBe(false);
    });

    it('корректно определяет ночной режим', () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 3, 0));
      expect(service.nowIsMode(PublicationModesEnum.NIGHT_CRINGE)).toBe(true);
      expect(service.nowIsMode(PublicationModesEnum.NEXT_MIDDAY)).toBe(false);
    });
  });

  describe('addPostToSchedule', () => {
    it('планирует пост, создаёт запись и сохраняет в транзакции', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 9, 0));

      const publishDate = await service.addPostToSchedule(baseContext as any);

      expect(repo.count).toHaveBeenCalledWith({
        where: { requestChannelMessageId: 5 },
      });
      expect(repo.create).toHaveBeenCalledWith({
        publishDate,
        requestChannelMessageId: 5,
        processedByModerator: { id: 9 },
        mode: PublicationModesEnum.NEXT_MIDDAY,
        caption: 'cap',
        isPublished: false,
        isUserPost: true,
        hash: 'h',
      });
      expect(repo.save).toHaveBeenCalledWith(repo.create.mock.calls[0][0], {
        transaction: true,
      });
      expect(publishDate.getTime()).toBe(msk(2026, 1, 15, 16, 0).getTime());
    });

    it('ничего не делает, если пост с таким сообщением уже запланирован', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 9, 0));
      repo.count.mockResolvedValue(1);

      await expect(service.addPostToSchedule(baseContext as any)).resolves.toBeUndefined();
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('nextScheduledTimeByMode (через addPostToSchedule)', () => {
    it('вне окна и без постов выбирает середину интервала', async () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 9, 0));

      const date = await service.addPostToSchedule(baseContext as any);
      expect(date.getTime()).toBe(msk(2026, 1, 15, 16, 0).getTime());
    });

    it('внутри окна сдвигается от текущей минуты до следующего получаса', async () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 15, 47));

      const date = await service.addPostToSchedule(baseContext as any);
      expect(date.getTime()).toBe(msk(2026, 1, 15, 17, 30).getTime());
    });

    it('после окна переносит слот на следующий день', async () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 20, 0));

      const date = await service.addPostToSchedule(baseContext as any);
      expect(date.getTime()).toBe(msk(2026, 1, 16, 16, 0).getTime());
    });

    it('для NOW_SILENT/NIGHT_CRINGE/NEXT_INTERVAL берёт первый слот', async () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 7, 0));

      const date = await service.addPostToSchedule({
        ...baseContext,
        mode: PublicationModesEnum.NEXT_INTERVAL,
      } as any);
      expect(date.getTime()).toBe(msk(2026, 1, 15, 9, 0).getTime());
    });

    it('для NIGHT_CRINGE берёт первый слот ночного окна', async () => {
      const { service } = setup();
      withNow(msk(2026, 1, 15, 1, 0));

      const date = await service.addPostToSchedule({
        ...baseContext,
        mode: PublicationModesEnum.NIGHT_CRINGE,
      } as any);
      expect(date.getTime()).toBe(msk(2026, 1, 15, 2, 0).getTime());
    });

    it('переносит поиск на следующий день, если день занят посты', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 9, 0));
      const day0Posts = [13, 14, 15, 16, 17, 18].map((h) => ({
        publishDate: msk(2026, 1, 15, h, 0),
      }));
      repo.find
        .mockResolvedValueOnce(day0Posts)
        .mockResolvedValue([{ publishDate: msk(2026, 1, 16, 13, 0) }]);

      const date = await service.addPostToSchedule(baseContext as any);

      expect(repo.find).toHaveBeenCalledTimes(2);
      expect(date.getTime()).toBe(msk(2026, 1, 16, 18, 30).getTime());
    });

    it('выбирает слот с максимальным расстоянием до ближайшего поста', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 9, 0));
      repo.find.mockResolvedValue([
        { publishDate: msk(2026, 1, 15, 14, 0) },
        { publishDate: msk(2026, 1, 15, 13, 0) },
      ]);

      const date = await service.addPostToSchedule(baseContext as any);
      expect(date.getTime()).toBe(msk(2026, 1, 15, 18, 30).getTime());
    });

    it('после 30 дней без свободного слота возвращает фолбэк без сдвига минут', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 9, 0));
      repo.find.mockResolvedValue([{ publishDate: new Date('invalid') }]);

      const date = await service.addPostToSchedule(baseContext as any);

      expect(repo.find).toHaveBeenCalledTimes(30);
      // Не прыгаем на 14 дней — берём начало интервала на следующие сутки.
      expect(date.getTime()).toBe(msk(2026, 1, 16, 13, 0).getTime());
    });

    it('фолбэк округляет минуты вверх до получаса', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 9, 10));
      repo.find.mockResolvedValue([{ publishDate: new Date('invalid') }]);

      const date = await service.addPostToSchedule(baseContext as any);
      expect(date.getTime()).toBe(msk(2026, 1, 16, 13, 0).getTime());
    });
  });

  describe('formatToMsk', () => {
    it('переводит UTC-время в московское', () => {
      const result = PostSchedulerService.formatToMsk(new Date('2026-01-15T13:00:00Z'));
      expect(result.getUTCHours()).toBe(16);
      expect(result.getUTCMinutes()).toBe(0);
    });
  });

  describe('getAllScheduledPosts', () => {
    it('возвращает неопубликованные посты по возрастанию даты', async () => {
      const { service, repo } = setup();
      const posts = [{ id: 1 }, { id: 2 }];
      repo.find.mockResolvedValue(posts);

      await expect(service.getAllScheduledPosts()).resolves.toBe(posts);
      expect(repo.find).toHaveBeenCalledWith({
        where: { isPublished: false },
        order: { publishDate: 'ASC' },
      });
    });
  });

  describe('getScheduledPostById', () => {
    it('ищет пост по id', async () => {
      const { service, repo } = setup();
      const post = { id: 3 };
      repo.findOne.mockResolvedValue(post);

      await expect(service.getScheduledPostById(3)).resolves.toBe(post);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 3 } });
    });
  });

  describe('markPostAsPublished', () => {
    it('проставляет isPublished=true по id', async () => {
      const { service, repo } = setup();

      await expect(service.markPostAsPublished(8)).resolves.toEqual({ affected: 1 });
      expect(repo.update).toHaveBeenCalledWith({ id: 8 }, { isPublished: true });
    });
  });

  describe('getUpcomingPage', () => {
    const baseArgs = {
      relations: { processedByModerator: true },
      order: { publishDate: 'ASC', id: 'ASC' },
      take: 8,
      skip: 16,
      cache: false,
    };

    it('без фильтра типа ключ isUserPost в where отсутствует', async () => {
      const { service, repo } = setup();
      const posts = [{ id: 1 }];
      repo.find.mockResolvedValue(posts);

      await expect(service.getUpcomingPage(8, 16)).resolves.toBe(posts);
      expect(repo.find).toHaveBeenCalledWith({
        where: { isPublished: false },
        ...baseArgs,
      });
    });

    it('фильтр «юзерские» добавляет isUserPost=true', async () => {
      const { service, repo } = setup();
      repo.find.mockResolvedValue([]);

      await service.getUpcomingPage(8, 16, true);
      expect(repo.find).toHaveBeenCalledWith({
        where: { isPublished: false, isUserPost: true },
        ...baseArgs,
      });
    });

    it('фильтр «парсер» добавляет isUserPost=false', async () => {
      const { service, repo } = setup();
      repo.find.mockResolvedValue([]);

      await service.getUpcomingPage(8, 16, false);
      expect(repo.find).toHaveBeenCalledWith({
        where: { isPublished: false, isUserPost: false },
        ...baseArgs,
      });
    });
  });

  describe('getFurthestUpcoming', () => {
    it('берёт самый поздний неопубликованный пост', async () => {
      const { service, repo } = setup();
      const post = { id: 4, publishDate: msk(2026, 1, 20, 10) };
      repo.findOne.mockResolvedValue(post);

      await expect(service.getFurthestUpcoming()).resolves.toBe(post);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { isPublished: false },
        order: { publishDate: 'DESC' },
        cache: false,
      });
    });
  });

  describe('countUpcoming', () => {
    it('без фильтра типа ключ isUserPost в where отсутствует', async () => {
      const { service, repo } = setup();
      repo.count.mockResolvedValue(17);

      await expect(service.countUpcoming()).resolves.toBe(17);
      expect(repo.count).toHaveBeenCalledWith({ where: { isPublished: false } });
    });

    it('фильтр «юзерские» добавляет isUserPost=true', async () => {
      const { service, repo } = setup();
      repo.count.mockResolvedValue(3);

      await expect(service.countUpcoming(true)).resolves.toBe(3);
      expect(repo.count).toHaveBeenCalledWith({
        where: { isPublished: false, isUserPost: true },
      });
    });

    it('фильтр «парсер» добавляет isUserPost=false', async () => {
      const { service, repo } = setup();
      repo.count.mockResolvedValue(2);

      await expect(service.countUpcoming(false)).resolves.toBe(2);
      expect(repo.count).toHaveBeenCalledWith({
        where: { isPublished: false, isUserPost: false },
      });
    });
  });

  describe('findByRequestMessageId', () => {
    it('ищет неопубликованную запись по сообщению, свежую первой', async () => {
      const { service, repo } = setup();
      const post = { id: 4 };
      repo.findOne.mockResolvedValue(post);

      await expect(service.findByRequestMessageId(7777)).resolves.toBe(post);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { requestChannelMessageId: 7777, isPublished: false },
        order: { id: 'DESC' },
      });
    });
  });

  describe('removeByRequestMessageId', () => {
    it('удаляет записи по сообщению и возвращает число affected', async () => {
      const { service, repo } = setup();
      repo.delete.mockResolvedValue({ affected: 2 });

      await expect(service.removeByRequestMessageId(7777)).resolves.toBe(2);
      expect(repo.delete).toHaveBeenCalledWith({
        requestChannelMessageId: 7777,
        isPublished: false,
      });
    });

    it('приводит id к числу и при отсутствии affected отдаёт 0', async () => {
      const { service, repo } = setup();
      repo.delete.mockResolvedValue({});

      await expect(service.removeByRequestMessageId('5' as never)).resolves.toBe(0);
      expect(repo.delete).toHaveBeenCalledWith({
        requestChannelMessageId: 5,
        isPublished: false,
      });
    });
  });

  describe('removeById', () => {
    it('удаляет запись по id и возвращает число affected', async () => {
      const { service, repo } = setup();
      repo.delete.mockResolvedValue({ affected: 1 });

      await expect(service.removeById(12)).resolves.toBe(1);
      expect(repo.delete).toHaveBeenCalledWith({ id: 12, isPublished: false });
    });

    it('при отсутствии affected отдаёт 0', async () => {
      const { service, repo } = setup();
      repo.delete.mockResolvedValue({ affected: undefined });

      await expect(service.removeById(12)).resolves.toBe(0);
    });
  });

  describe('ночные слоты кринжа', () => {
    it('первый свободный слот — 02:00, шаг 90 минут', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 10, 0));
      repo.findOne.mockResolvedValue(null);
      const date = await service.addPostToSchedule({
        ...baseContext,
        mode: PublicationModesEnum.NIGHT_CRINGE,
      } as any);
      const mskDate = PostSchedulerService.formatToMsk(date);
      expect(mskDate.getUTCHours()).toBe(2);
      expect(mskDate.getUTCMinutes()).toBe(0);
    });

    it('если 02:00 занято — берёт 03:30', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 10, 0));
      repo.findOne.mockResolvedValueOnce({ id: 1 }).mockResolvedValue(null);
      const date = await service.addPostToSchedule({
        ...baseContext,
        mode: PublicationModesEnum.NIGHT_CRINGE,
      } as any);
      const mskDate = PostSchedulerService.formatToMsk(date);
      expect(mskDate.getUTCHours()).toBe(3);
      expect(mskDate.getUTCMinutes()).toBe(30);
    });

    it('когда вся ночь занята — переносит на следующую', async () => {
      const { service, repo } = setup();
      withNow(msk(2026, 1, 15, 10, 0));
      repo.findOne.mockResolvedValue({ id: 1 });
      const date = await service.addPostToSchedule({
        ...baseContext,
        mode: PublicationModesEnum.NIGHT_CRINGE,
      } as any);
      expect(PostSchedulerService.formatToMsk(date).getTime()).toBeGreaterThan(
        msk(2026, 1, 15, 6, 0).getTime()
      );
    });
  });
});
