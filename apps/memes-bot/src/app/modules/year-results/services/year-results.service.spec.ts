import { Logger } from '@nestjs/common';
import { YearResultsService } from './year-results.service';
import { UserYearStatistics } from '../interfaces/year-statistics.interface';

/**
 * Хелперы для ручных моков TypeORM.
 *
 * Все запросы идут последовательно (await), поэтому терминальные методы
 * (`getCount`/`getRawOne`/`getRawMany`) детерминированно забирают значения
 * из очереди репозитория. Это позволяет проверять реальные вычисления сервиса.
 */

function makeQueryBuilder(): any {
  const qb: any = {};
  const chain = [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orWhere',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'addGroupBy',
    'having',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
    'setParameter',
    'setParameters',
  ];
  chain.forEach((m) => {
    qb[m] = jest.fn(() => qb);
  });
  return qb;
}

function makeRepo(): any {
  const repo: any = {
    _qbQueue: [] as any[],
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
  };
  repo.createQueryBuilder = jest.fn(() => {
    const qb = makeQueryBuilder();
    const next = () =>
      Promise.resolve(repo._qbQueue.length ? repo._qbQueue.shift() : undefined);
    qb.getCount = jest.fn(next);
    qb.getRawOne = jest.fn(next);
    qb.getRawMany = jest.fn(next);
    qb.getMany = jest.fn(next);
    qb.getOne = jest.fn(next);
    return qb;
  });
  return repo;
}

function seed(repo: any, values: any[]): void {
  repo._qbQueue.push(...values);
}

function createHarness() {
  const yearResultRepository = makeRepo();
  const userRequestRepository = makeRepo();
  const cringePostRepository = makeRepo();
  const publishedPostHashesRepository = makeRepo();
  const postSchedulerRepository = makeRepo();
  const observatoryPostRepository = makeRepo();
  const bot = {
    api: {
      getMe: jest.fn(),
      sendMessage: jest.fn(),
    },
  };
  const baseConfigService = { memeChanelId: -1001709979748, ownerId: 777 };
  const service = new YearResultsService(
    yearResultRepository,
    userRequestRepository,
    cringePostRepository,
    publishedPostHashesRepository,
    postSchedulerRepository,
    observatoryPostRepository,
    bot as any,
    baseConfigService as any
  );
  return {
    service,
    yearResultRepository,
    userRequestRepository,
    cringePostRepository,
    postSchedulerRepository,
    observatoryPostRepository,
    bot,
    baseConfigService,
  };
}

function zeroGeneral(overrides: Record<string, any> = {}): any {
  return {
    totalModeratedMessages: 0,
    totalMemes: 0,
    memesFromUsers: 0,
    memesFromObservatory: 0,
    totalProposedByUsers: 0,
    textMessagesToAdmin: 0,
    adminRepliedToMessages: 0,
    adminReplyPercentage: 0,
    cringeMemes: 0,
    duplicatesFound: 0,
    year: 2024,
    totalAuthors: 0,
    activeDaysWithMemes: 0,
    ...overrides,
  };
}

function personalUser(overrides: Record<string, any> = {}): UserYearStatistics {
  return {
    userId: 1,
    username: 'u1',
    firstName: 'Иван',
    lastName: 'Иванов',
    totalProposed: 10,
    totalPublished: 5,
    totalRejected: 2,
    totalCringe: 1,
    firstProposalDate: new Date('2024-01-01'),
    activeDays: 3,
    longestStreak: 2,
    approvalRate: 50,
    averageTimeToPublication: 10,
    mostActiveTimeOfDay: 'утром',
    duplicatesCount: 1,
    duplicatesPercentage: 5,
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('YearResultsService.collectGeneralStatistics', () => {
  it('собирает все показатели за год с реальными вычислениями', async () => {
    const h = createHarness();
    seed(h.userRequestRepository, [
      100, // totalProposedByUsers
      40, // memesFromUsers
      30, // textMessagesToAdmin
      20, // adminRepliedToMessages
      5, // duplicatesFound
      { count: '12' }, // totalAuthors
      [
        { date: '2024-03-01', count: '3' },
        { date: '2024-03-02', count: '2' },
      ], // daysWithMemes
      [
        { month: '3', count: '40' },
        { month: '7', count: '5' },
      ], // monthlyStats
      100, // totalProposed
      {
        userId: '1',
        username: 'vasya',
        firstName: 'Вася',
        lastName: 'Пупкин',
        duplicates_count: '3',
        totalCount: '10',
      }, // topDuplicateUser
      { avgMinutes: '30' },
      { avgHours: '5' },
    ]);
    seed(h.observatoryPostRepository, [10]); // totalObservatoryPosts
    seed(h.postSchedulerRepository, [
      30, // memesFromObservatory
      { mode: 'NEXT_MORNING' }, // publicationModes
      { date: '2024-05-01', queue_length: '7' }, // longestQueue
    ]);
    seed(h.cringePostRepository, [4]); // cringeMemes

    const result = await h.service.collectGeneralStatistics(2024);

    expect(result.year).toBe(2024);
    expect(result.totalModeratedMessages).toBe(110);
    expect(result.totalMemes).toBe(70);
    expect(result.memesFromUsers).toBe(40);
    expect(result.memesFromObservatory).toBe(30);
    expect(result.totalProposedByUsers).toBe(100);
    expect(result.textMessagesToAdmin).toBe(30);
    expect(result.adminRepliedToMessages).toBe(20);
    expect(result.adminReplyPercentage).toBe(67);
    expect(result.cringeMemes).toBe(4);
    expect(result.duplicatesFound).toBe(5);
    expect(result.totalAuthors).toBe(12);
    expect(result.activeDaysWithMemes).toBe(2);
    expect(result.mostProductiveDay).toEqual(new Date('2024-03-01'));
    expect(result.mostProductiveDayCount).toBe(3);
    expect(result.mostActiveMonth).toBe('март');
    expect(result.mostActiveMonthCount).toBe(40);
    expect(result.leastActiveMonth).toBe('июль');
    expect(result.leastActiveMonthCount).toBe(5);
    expect(result.mostPopularPublicationMode).toBe('утро');
    expect(result.duplicatesPercentage).toBe(5);
    expect(result.averageTimeToModeration).toBe(30);
    expect(result.averageTimeFromModerationToPublication).toBe(5);
    expect(result.longestQueueDate).toEqual(new Date('2024-05-01'));
    expect(result.longestQueueLength).toBe(7);
    expect(result.topDuplicateUser).toEqual({
      username: 'vasya',
      firstName: 'Вася',
      lastName: 'Пупкин',
      duplicatesCount: 3,
      duplicatesPercentage: 30,
    });
  });

  it('возвращает undefined/нули когда данных нет', async () => {
    const h = createHarness();
    seed(h.userRequestRepository, [
      0,
      0,
      0,
      0,
      0,
      undefined, // totalAuthors отсутствует
      [], // нет дней
      [], // нет месяцев
      0,
      undefined, // нет топа дубликатов
      undefined,
      undefined,
    ]);
    seed(h.observatoryPostRepository, [0]);
    seed(h.postSchedulerRepository, [0, undefined, undefined]);
    seed(h.cringePostRepository, [0]);

    const result = await h.service.collectGeneralStatistics(2024);

    expect(result.totalModeratedMessages).toBe(0);
    expect(result.totalMemes).toBe(0);
    expect(result.adminReplyPercentage).toBe(0);
    expect(result.totalAuthors).toBe(0);
    expect(result.activeDaysWithMemes).toBe(0);
    expect(result.mostProductiveDay).toBeUndefined();
    expect(result.mostProductiveDayCount).toBeUndefined();
    expect(result.mostActiveMonth).toBeUndefined();
    expect(result.leastActiveMonth).toBeUndefined();
    expect(result.mostPopularPublicationMode).toBeUndefined();
    expect(result.duplicatesPercentage).toBe(0);
    expect(result.averageTimeToModeration).toBeUndefined();
    expect(result.averageTimeFromModerationToPublication).toBeUndefined();
    expect(result.longestQueueDate).toBeUndefined();
    expect(result.longestQueueLength).toBeUndefined();
    expect(result.topDuplicateUser).toBeUndefined();
  });

  it('обрабатывает единственный месяц и неизвестный режим публикации', async () => {
    const h = createHarness();
    seed(h.userRequestRepository, [
      10,
      5,
      5,
      3,
      1,
      { count: '2' },
      [{ date: '2024-01-05', count: '2' }],
      [{ month: '12', count: '10' }],
      10,
      {
        username: 'x',
        firstName: 'y',
        lastName: 'z',
        duplicates_count: '1',
        totalCount: '2',
      },
      { avgMinutes: '90' },
      { avgHours: '30' },
    ]);
    seed(h.observatoryPostRepository, [0]);
    seed(h.postSchedulerRepository, [0, { mode: 'CUSTOM_MODE' }, { date: '2024-02-02', queue_length: '3' }]);
    seed(h.cringePostRepository, [0]);

    const result = await h.service.collectGeneralStatistics(2024);

    expect(result.mostActiveMonth).toBe('декабрь');
    expect(result.leastActiveMonth).toBeUndefined();
    expect(result.mostPopularPublicationMode).toBe('CUSTOM_MODE');
    expect(result.duplicatesPercentage).toBe(10);
    expect(result.topDuplicateUser?.duplicatesPercentage).toBe(50);
    expect(result.averageTimeToModeration).toBe(90);
    expect(result.averageTimeFromModerationToPublication).toBe(30);
    expect(result.longestQueueLength).toBe(3);
  });
});

describe('YearResultsService.collectUserStatistics', () => {
  function seedUserStats(h: ReturnType<typeof createHarness>) {
    seed(h.userRequestRepository, [
      [
        {
          userId: '1',
          username: 'u1',
          firstName: 'A',
          lastName: 'B',
          totalProposed: '12',
          totalPublished: '8',
          totalRejected: '2',
          firstProposalDate: '2024-01-05',
        },
        {
          userId: '2',
          username: '',
          firstName: 'C',
          lastName: '',
          totalProposed: '3',
          totalPublished: '1',
          totalRejected: null,
          firstProposalDate: '2024-02-01',
        },
        {
          userId: '3',
          username: null,
          firstName: 'E',
          lastName: 'F',
          totalProposed: '10',
          totalPublished: '5',
          totalRejected: '1',
          firstProposalDate: '2024-03-01',
        },
        {
          userId: '4',
          username: 'u4',
          firstName: 'G',
          lastName: 'H',
          totalProposed: '4',
          totalPublished: '2',
          totalRejected: '1',
          firstProposalDate: '2024-04-01',
        },
        {
          userId: '5',
          username: 'u5',
          firstName: 'I',
          lastName: 'J',
          totalProposed: '6',
          totalPublished: '3',
          totalRejected: '2',
          firstProposalDate: '2024-05-01',
        },
        {
          userId: '6',
          username: 'u6',
          firstName: 'K',
          lastName: 'L',
          totalProposed: '0',
          totalPublished: '0',
          totalRejected: '0',
          firstProposalDate: '2024-06-01',
        },
      ],
      // user 1: активность со серией и самым продуктивным днём
      [
        { date: '2024-01-01', count: '1' },
        { date: '2024-01-02', count: '1' },
        { date: '2024-01-04', count: '3' },
        { date: '2024-01-05', count: '5' },
      ],
      { avgHours: '10' },
      { hour: '9' },
      1,
      // user 2: пустая активность, днём
      [],
      null,
      { hour: '15' },
      0,
      // user 3: вечером, avgHours '0'
      [{ date: '2024-03-01', count: '1' }],
      { avgHours: '0' },
      { hour: '20' },
      2,
      // user 4: ночью, avgHours null, разрыв в серии
      [
        { date: '2024-04-01', count: '1' },
        { date: '2024-04-03', count: '1' },
        { date: '2024-04-05', count: '2' },
      ],
      { avgHours: null },
      { hour: '2' },
      0,
      // user 5: без времени суток, avg отсутствует
      [{ date: '2024-05-01', count: '1' }],
      undefined,
      null,
      0,
      // user 6: без публикаций
      [],
      null,
      null,
      0,
    ]);
    seed(h.cringePostRepository, [2, 0, 1, 0, 0, 0]);
  }

  it('считает персональную статистику по каждому пользователю', async () => {
    const h = createHarness();
    seedUserStats(h);

    const result = await h.service.collectUserStatistics(2024);

    expect(result).toHaveLength(6);

    const first = result[0];
    expect(first.userId).toBe(1);
    expect(first.totalProposed).toBe(12);
    expect(first.totalPublished).toBe(8);
    expect(first.totalRejected).toBe(2);
    expect(first.totalCringe).toBe(2);
    expect(first.activeDays).toBe(4);
    expect(first.longestStreak).toBe(2);
    expect(first.mostProductiveDay).toEqual(new Date('2024-01-05'));
    expect(first.mostProductiveDayCount).toBe(5);
    expect(first.approvalRate).toBe(67);
    expect(first.averageTimeToPublication).toBe(10);
    expect(first.mostActiveTimeOfDay).toBe('утром');
    expect(first.duplicatesCount).toBe(1);
    expect(first.duplicatesPercentage).toBe(8);
    expect(first.firstProposalDate).toEqual(new Date('2024-01-05'));

    // второй: пустая активность и отсутствующий avg
    expect(result[1].activeDays).toBe(0);
    expect(result[1].longestStreak).toBe(0);
    expect(result[1].mostProductiveDay).toBeUndefined();
    expect(result[1].averageTimeToPublication).toBeUndefined();
    expect(result[1].mostActiveTimeOfDay).toBe('днём');
    expect(result[1].totalRejected).toBe(0);

    // третий: '0' как avgHours, вечер
    expect(result[2].mostActiveTimeOfDay).toBe('вечером');
    expect(result[2].averageTimeToPublication).toBe(0);

    // четвёртый: ночь и undefined avg
    expect(result[3].mostActiveTimeOfDay).toBe('ночью');
    expect(result[3].averageTimeToPublication).toBeUndefined();
    expect(result[3].longestStreak).toBe(1);

    // пятый: без времени суток
    expect(result[4].mostActiveTimeOfDay).toBeUndefined();

    // шестой: нулевые проценты
    expect(result[5].approvalRate).toBe(0);
    expect(result[5].duplicatesPercentage).toBe(0);
  });

  it('возвращает пустой массив если пользователей нет', async () => {
    const h = createHarness();
    seed(h.userRequestRepository, [[]]);

    const result = await h.service.collectUserStatistics(2024);

    expect(result).toEqual([]);
  });
});

describe('YearResultsService.generateYearResults', () => {
  it('удаляет старые результаты и сохраняет новых пользователей', async () => {
    const h = createHarness();
    const general = zeroGeneral({ year: 2024, totalMemes: 3 });
    const user = personalUser({ userId: 5, totalProposed: 9 });
    jest.spyOn(h.service, 'collectGeneralStatistics').mockResolvedValue(general);
    jest.spyOn(h.service, 'collectUserStatistics').mockResolvedValue([user]);
    h.yearResultRepository.delete.mockResolvedValue({ affected: 2 });
    h.yearResultRepository.save.mockResolvedValue({});

    const result = await h.service.generateYearResults(2024);

    expect(h.yearResultRepository.delete).toHaveBeenCalledWith({ year: 2024 });
    expect(h.yearResultRepository.save).toHaveBeenCalledTimes(1);
    expect(h.yearResultRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        year: 2024,
        userId: 5,
        totalProposed: 9,
        totalPublished: 5,
        isPublished: false,
      })
    );
    expect(result).toEqual({ general, users: [user] });
  });

  it('сохраняет ноль записей когда пользователей нет', async () => {
    const h = createHarness();
    const general = zeroGeneral({ year: 2023 });
    jest.spyOn(h.service, 'collectGeneralStatistics').mockResolvedValue(general);
    jest.spyOn(h.service, 'collectUserStatistics').mockResolvedValue([]);

    const result = await h.service.generateYearResults(2023);

    expect(h.yearResultRepository.delete).toHaveBeenCalledWith({ year: 2023 });
    expect(h.yearResultRepository.save).not.toHaveBeenCalled();
    expect(result).toEqual({ general, users: [] });
  });
});

describe('YearResultsService.getYearResults', () => {
  it('склеивает общую статистику с сохранёнными пользователями', async () => {
    const h = createHarness();
    const general = zeroGeneral({ year: 2022, totalMemes: 7 });
    jest.spyOn(h.service, 'collectGeneralStatistics').mockResolvedValue(general);
    h.yearResultRepository.find.mockResolvedValue([
      {
        userId: 11,
        username: 'saved',
        firstName: 'П',
        lastName: 'С',
        totalProposed: 4,
        totalPublished: 2,
        totalRejected: 1,
        totalCringe: 3,
        firstProposalDate: new Date('2022-02-02'),
        activeDays: 2,
        longestStreak: 1,
        mostProductiveDay: new Date('2022-02-03'),
        mostProductiveDayCount: 2,
        approvalRate: 50,
        averageTimeToPublication: 12,
        mostActiveTimeOfDay: 'днём',
        duplicatesCount: 1,
        duplicatesPercentage: 25,
      },
    ]);

    const result = await h.service.getYearResults(2022);

    expect(h.yearResultRepository.find).toHaveBeenCalledWith({
      where: { year: 2022 },
      order: { totalProposed: 'DESC' },
    });
    expect(result.general).toBe(general);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toEqual(
      expect.objectContaining({
        userId: 11,
        username: 'saved',
        totalCringe: 3,
        mostActiveTimeOfDay: 'днём',
        duplicatesPercentage: 25,
      })
    );
  });

  it('возвращает пустой список пользователей', async () => {
    const h = createHarness();
    const general = zeroGeneral({ year: 2021 });
    jest.spyOn(h.service, 'collectGeneralStatistics').mockResolvedValue(general);
    h.yearResultRepository.find.mockResolvedValue([]);

    const result = await h.service.getYearResults(2021);

    expect(result.users).toEqual([]);
  });
});

describe('YearResultsService.formatGeneralStatistics', () => {
  it('формирует минимальный текст без дополнительных блоков', () => {
    const h = createHarness();
    const text = h.service.formatGeneralStatistics(zeroGeneral(), []);

    expect(text).toContain('Итоги 2024 года');
    expect(text).toContain('опубликовано <b>0</b> постов');
    expect(text).not.toContain('обсерваторией');
    expect(text).not.toContain('Пользователи предложили');
    expect(text.endsWith('#итоги_года')).toBe(true);
  });

  it('описывает единичные значения правильными словами', () => {
    const h = createHarness();
    const general = zeroGeneral({
      totalMemes: 3,
      memesFromObservatory: 1,
      memesFromUsers: 1,
      totalProposedByUsers: 10,
      textMessagesToAdmin: 1,
      adminRepliedToMessages: 1,
      adminReplyPercentage: 100,
      cringeMemes: 1,
      duplicatesFound: 1,
      totalAuthors: 1,
      activeDaysWithMemes: 1,
      mostProductiveDay: new Date('2024-03-05'),
      mostProductiveDayCount: 1,
      mostActiveMonth: 'март',
      mostActiveMonthCount: 1,
      leastActiveMonth: 'июль',
      leastActiveMonthCount: 2,
      mostPopularPublicationMode: 'утро',
      duplicatesPercentage: 1,
      topDuplicateUser: {
        username: 'u',
        firstName: 'a',
        lastName: 'b',
        duplicatesCount: 1,
        duplicatesPercentage: 1,
      },
      totalModeratedMessages: 5,
      averageTimeToModeration: 5,
      averageTimeFromModerationToPublication: 5,
      longestQueueDate: new Date('2024-05-01'),
      longestQueueLength: 1,
    });
    const users = [{ totalPublished: 1, totalCringe: 1, totalProposed: 10 }];

    const text = h.service.formatGeneralStatistics(general, users);

    expect(text).toContain('был найден обсерваторией');
    expect(text).toContain('создавал контент');
    expect(text).toContain('обращение');
    expect(text).toContain('попал в кринж');
    expect(text).toContain('дубликат');
    expect(text).toContain('Самым продуктивным днём стал');
    expect(text).toContain('Самым активным месяцем стал');
    expect(text).toContain('ожидал своей очереди');
    expect(text).toContain('был опубликован');
    expect(text).toContain('оказался дубликатами');
    expect(text).toContain('был дубликатами');
    expect(text).toContain('человеку были');
    expect(text).toContain('публикуется');
  });

  it('описывает множественные значения и NEXT_INTERVAL', () => {
    const h = createHarness();
    const general = zeroGeneral({
      totalMemes: 100,
      memesFromObservatory: 5,
      memesFromUsers: 10,
      totalProposedByUsers: 20,
      textMessagesToAdmin: 5,
      adminRepliedToMessages: 3,
      totalAuthors: 2,
      activeDaysWithMemes: 3,
      cringeMemes: 2,
      duplicatesFound: 0,
      mostProductiveDay: new Date('2024-03-05'),
      mostProductiveDayCount: 3,
      mostActiveMonth: 'март',
      mostActiveMonthCount: 5,
      leastActiveMonth: 'июль',
      leastActiveMonthCount: 1,
      mostPopularPublicationMode: 'NEXT_INTERVAL',
      duplicatesPercentage: 5,
      topDuplicateUser: { duplicatesCount: 0, duplicatesPercentage: 0 } as any,
      totalModeratedMessages: 50,
      averageTimeToModeration: 90,
      averageTimeFromModerationToPublication: 50,
      longestQueueDate: new Date('2024-05-01'),
      longestQueueLength: 2,
    });
    const users = [
      { totalProposed: 10, totalPublished: 9, totalCringe: 4 },
      { totalProposed: 20, totalPublished: 2, totalCringe: 1 },
    ];

    const text = h.service.formatGeneralStatistics(general, users);

    expect(text).toContain('были найдены обсерваторией');
    expect(text).toContain('были опубликованы');
    expect(text).toContain('Самым активным месяцем стали');
    expect(text).toContain('попали');
    expect(text).toContain('оказались дубликатами');
    expect(text).toContain('попадают в публикацию');
    expect(text).toContain('публикуются');
    expect(text).toContain('людям были');
    expect(text).not.toContain('NEXT_INTERVAL');
    // 90 минут => 2 часа, 50 часов => 2 дня и 2 часа
    expect(text).toContain('за <b>2</b> часа');
    expect(text).toContain('и <b>2</b> часа');
    expect(text).toContain('ожидали своей очереди');
  });

  it('описывает только дубликаты без кринжа и неполные метрики', () => {
    const h = createHarness();
    const general = zeroGeneral({
      totalMemes: 10,
      totalProposedByUsers: 10,
      memesFromUsers: 0,
      cringeMemes: 0,
      duplicatesFound: 2,
      duplicatesPercentage: 20,
      topDuplicateUser: { duplicatesCount: 2, duplicatesPercentage: 50 } as any,
      textMessagesToAdmin: 2,
      adminRepliedToMessages: 0,
      totalAuthors: 2,
      activeDaysWithMemes: 2,
      averageTimeToModeration: 10,
    });

    const text = h.service.formatGeneralStatistics(general, []);

    expect(text).toContain('Система нашла <b>2</b> дубликатов');
    expect(text).toContain('оказались дубликатами');
    expect(text).toContain('были дубликатами');
    expect(text).toContain('написали');
    expect(text).not.toContain('обсерваторией');
  });

  it('не печатает остаток часов при ровных сутках', () => {
    const h = createHarness();
    const general = zeroGeneral({
      totalMemes: 1,
      totalProposedByUsers: 1,
      memesFromUsers: 1,
      averageTimeFromModerationToPublication: 48,
      longestQueueDate: new Date('2024-05-01'),
      longestQueueLength: 3,
    });

    const text = h.service.formatGeneralStatistics(general, []);

    expect(text).toContain('проходило <b>2</b> дня');
    expect(text).not.toContain('и <b>0</b>');
    expect(text).toContain('ожидали своей очереди');
  });

  it('выбирает лидеров, когда больший показатель у более позднего пользователя', () => {
    const h = createHarness();
    const general = zeroGeneral({
      totalMemes: 10,
      totalProposedByUsers: 10,
      memesFromUsers: 5,
      cringeMemes: 3,
      duplicatesFound: 4,
      duplicatesPercentage: 40,
      topDuplicateUser: { duplicatesCount: 1, duplicatesPercentage: 50 } as any,
    });
    const users = [
      { totalProposed: 20, totalPublished: 2, totalCringe: 1 },
      { totalProposed: 12, totalPublished: 8, totalCringe: 5 },
    ];

    const text = h.service.formatGeneralStatistics(general, users);

    // кринж есть и дубликатов больше одного — множественная форма
    expect(text).toContain('попали в кринж');
    expect(text).toContain('а система нашла <b>4</b> дубликатов');
    // лидеры найдены во второй итерации reduce
    expect(text).toContain('<b>8</b> постов от одного автора');
    expect(text).toContain('<b>5</b> постов от одного автора');
  });

  it('печатает единственный дубликат без кринжа', () => {
    const h = createHarness();
    const general = zeroGeneral({
      totalMemes: 5,
      totalProposedByUsers: 5,
      memesFromUsers: 1,
      cringeMemes: 0,
      duplicatesFound: 1,
      duplicatesPercentage: 20,
    });

    const text = h.service.formatGeneralStatistics(general, []);

    expect(text).toContain('Система нашла <b>1</b> дубликат');
    expect(text).not.toContain('в кринж');
  });
});

describe('YearResultsService.publishGeneralStatistics', () => {
  it('публикует текст с inline-кнопкой', async () => {
    const h = createHarness();
    const general = zeroGeneral({ year: 2024, totalMemes: 1 });
    jest.spyOn(h.service, 'getYearResults').mockResolvedValue({ general, users: [] });
    h.bot.api.getMe.mockResolvedValue({ username: 'memebot' });
    h.bot.api.sendMessage.mockResolvedValue({ message_id: 1 });

    await h.service.publishGeneralStatistics(2024);

    expect(h.bot.api.getMe).toHaveBeenCalled();
    expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
      h.baseConfigService.memeChanelId,
      expect.stringContaining('Итоги 2024 года'),
      expect.objectContaining({ parse_mode: 'HTML', reply_markup: expect.anything() })
    );
  });
});

describe('YearResultsService.publishPersonalStatistics', () => {
  function savedEntity(overrides: Record<string, any> = {}): any {
    return {
      userId: 1,
      username: 'u1',
      firstName: 'И',
      lastName: 'И',
      totalProposed: 10,
      totalPublished: 5,
      totalRejected: 2,
      totalCringe: 1,
      firstProposalDate: new Date('2024-01-01'),
      activeDays: 3,
      longestStreak: 2,
      mostProductiveDay: new Date('2024-02-01'),
      mostProductiveDayCount: 2,
      approvalRate: 50,
      averageTimeToPublication: 10,
      mostActiveTimeOfDay: 'утром',
      duplicatesCount: 1,
      duplicatesPercentage: 5,
      ...overrides,
    };
  }

  it('выходит рано, когда нет неопубликованных результатов', async () => {
    const h = createHarness();
    h.yearResultRepository.find.mockResolvedValueOnce([]);

    await h.service.publishPersonalStatistics(2024);

    expect(h.yearResultRepository.find).toHaveBeenCalledTimes(1);
    expect(h.bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('отправляет сообщение и помечает запись опубликованной', async () => {
    const h = createHarness();
    const entity = savedEntity();
    h.yearResultRepository.find
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([entity]);
    h.bot.api.sendMessage.mockResolvedValue({ message_id: 1 });
    h.yearResultRepository.update.mockResolvedValue({ affected: 1 });
    jest.spyOn(h.service as any, 'delay').mockResolvedValue(undefined);

    await h.service.publishPersonalStatistics(2024);

    expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
      entity.userId,
      expect.stringContaining('Твои итоги 2024 года'),
      { parse_mode: 'HTML' }
    );
    expect(h.yearResultRepository.update).toHaveBeenCalledWith(
      { year: 2024, userId: entity.userId },
      expect.objectContaining({ isPublished: true, publishedAt: expect.any(Date) })
    );
  });

  it.each([
    'Forbidden: bot was blocked by the user',
    'Bad Request: user is deactivated',
    "Forbidden: bot can't initiate conversation with a user",
  ])('обрабатывает блокировку: %s', async (message) => {
    const h = createHarness();
    const entity = savedEntity();
    h.yearResultRepository.find
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([entity]);
    h.bot.api.sendMessage.mockRejectedValueOnce(new Error(message));
    h.yearResultRepository.update.mockResolvedValue({ affected: 1 });
    jest.spyOn(h.service as any, 'delay').mockResolvedValue(undefined);

    await h.service.publishPersonalStatistics(2024);

    expect(h.bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.yearResultRepository.update).toHaveBeenCalledWith(
      { year: 2024, userId: entity.userId },
      expect.objectContaining({ isPublished: true })
    );
  });

  it('повторяет отправку при временной ошибке и затем успешно', async () => {
    const h = createHarness();
    const entity = savedEntity({ userId: 2 });
    h.yearResultRepository.find
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([entity]);
    h.bot.api.sendMessage
      .mockRejectedValueOnce(new Error('Too Many Requests: retry later'))
      .mockResolvedValueOnce({ message_id: 9 });
    h.yearResultRepository.update.mockResolvedValue({ affected: 1 });
    const delay = jest
      .spyOn(h.service as any, 'delay')
      .mockResolvedValue(undefined);

    await h.service.publishPersonalStatistics(2024);

    expect(h.bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1000);
    expect(delay).toHaveBeenCalledWith(1500);
    expect(h.yearResultRepository.update).toHaveBeenCalledWith(
      { year: 2024, userId: 2 },
      expect.objectContaining({ isPublished: true })
    );
  });

  it('после трёх неудачных попыток логирует ошибку и не помечает опубликованным', async () => {
    const h = createHarness();
    const entity = savedEntity({ userId: 3 });
    h.yearResultRepository.find
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([entity]);
    h.bot.api.sendMessage.mockRejectedValue(new Error('network down'));
    jest.spyOn(h.service as any, 'delay').mockResolvedValue(undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    await h.service.publishPersonalStatistics(2024);

    expect(h.bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(h.yearResultRepository.update).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after all retries'),
      expect.any(Error)
    );
  });

  it('обрабатывает ошибку без message (optional chaining) как временную', async () => {
    const h = createHarness();
    const entity = savedEntity({ userId: 4 });
    h.yearResultRepository.find
      .mockResolvedValueOnce([entity])
      .mockResolvedValueOnce([entity]);
    h.bot.api.sendMessage.mockRejectedValue({});
    jest.spyOn(h.service as any, 'delay').mockResolvedValue(undefined);

    await h.service.publishPersonalStatistics(2024);

    expect(h.bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(h.yearResultRepository.update).not.toHaveBeenCalled();
  });
});

describe('YearResultsService.delay', () => {
  it('резолвится по истечении таймера', async () => {
    const h = createHarness();
    jest.useFakeTimers();
    try {
      const done = jest.fn();
      const promise = (h.service as any).delay(50).then(done);
      expect(done).not.toHaveBeenCalled();
      jest.advanceTimersByTime(50);
      await promise;
      expect(done).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('YearResultsService.formatPersonalMessage', () => {
  it('печатает все блоки для отличного пользователя', () => {
    const h = createHarness();
    const text = (h.service as any).formatPersonalMessage(
      personalUser({
        totalPublished: 1,
        totalCringe: 1,
        activeDays: 3,
        longestStreak: 2,
        mostProductiveDay: new Date('2024-02-01'),
        mostProductiveDayCount: 2,
        approvalRate: 75,
        averageTimeToPublication: 5,
        mostActiveTimeOfDay: 'утром',
        duplicatesCount: 1,
        duplicatesPercentage: 5,
      }),
      2024,
      90,
      10
    );

    expect(text).toContain('Твои итоги 2024 года');
    expect(text).toContain('Первый пост ты предложил');
    expect(text).toContain('был опубликован');
    expect(text).toContain('попал в кринж');
    expect(text).toContain('самая длинная серия составила');
    expect(text).toContain('мемной волне');
    expect(text).toContain('отличный результат');
    expect(text).toContain('Чаще всего ты предлагал посты');
    expect(text).toContain('ты хорошо следишь за уникальностью');
  });

  it('обрабатывает невалидную дату и средние оценки', () => {
    const h = createHarness();
    const text = (h.service as any).formatPersonalMessage(
      personalUser({
        firstProposalDate: new Date('invalid'),
        totalPublished: 2,
        totalCringe: 0,
        activeDays: 0,
        longestStreak: 0,
        mostProductiveDay: undefined,
        approvalRate: 60,
        averageTimeToPublication: 48,
        mostActiveTimeOfDay: undefined,
        duplicatesCount: 0,
      }),
      2024,
      10,
      10
    );

    expect(text).toContain('За этот год ты предложил');
    expect(text).toContain('были опубликованы');
    expect(text).toContain('неплохо');
    expect(text).toContain('через <b>2</b> дня');
    expect(text).not.toContain('попал в кринж');
  });

  it('предупреждает о большом проценте дубликатов и низком одобрении', () => {
    const h = createHarness();
    const text = (h.service as any).formatPersonalMessage(
      personalUser({
        totalCringe: 3,
        approvalRate: 30,
        averageTimeToPublication: 0,
        duplicatesCount: 12,
        duplicatesPercentage: 60,
      }),
      2024,
      5,
      100
    );

    expect(text).toContain('попали в кринж');
    expect(text).toContain('главное участие');
    expect(text).toContain('стоит проверять посты перед отправкой');
    expect(text).not.toContain('В среднем твои посты');
  });

  it('не показывает процент дубликатов при нуле и печатает "дубликат"', () => {
    const h = createHarness();
    const text = (h.service as any).formatPersonalMessage(
      personalUser({
        duplicatesCount: 1,
        duplicatesPercentage: 0,
        approvalRate: undefined,
        averageTimeToPublication: undefined,
        mostActiveTimeOfDay: undefined,
        totalCringe: 0,
        activeDays: 0,
      }),
      2024,
      5,
      100
    );

    expect(text).toContain('<b>1</b> пост-дубликат');
    expect(text).not.toContain('%</b>)');
  });
});

describe('YearResultsService.formatPreviewMessage', () => {
  it('выводит не более десяти пользователей', () => {
    const h = createHarness();
    const users = Array.from({ length: 12 }, (_, i) =>
      personalUser({ userId: i + 1, username: `u${i + 1}` })
    );

    const text = h.service.formatPreviewMessage({
      general: zeroGeneral({ year: 2024, totalMemes: 1, memesFromUsers: 1, cringeMemes: 2, duplicatesFound: 3 }),
      users,
    });

    expect(text).toContain('Предпросмотр итогов 2024 года');
    expect(text).toContain('Пользователи (12)');
    expect(text).toContain('... и еще 2 пользователей');
    expect(text).toContain('10. @u10');
  });

  it('выводит имя без username', () => {
    const h = createHarness();
    const text = h.service.formatPreviewMessage({
      general: zeroGeneral({ year: 2023 }),
      users: [personalUser({ username: '', firstName: 'Пётр', lastName: 'Петров' })],
    });

    expect(text).toContain('1. Пётр Петров - 10 постов');
    expect(text).not.toContain('... и еще');
  });
});

describe('YearResultsService.formatUserDetailMessage', () => {
  it('печатает детали с валидной датой и username', () => {
    const h = createHarness();
    const text = h.service.formatUserDetailMessage(
      personalUser({ username: 'vasya', firstProposalDate: new Date('2024-01-05'), longestStreak: 3 }),
      2024
    );

    expect(text).toContain('@vasya');
    expect(text).toContain('Статистика за 2024 год');
    expect(text).toContain('Первый пост: 5 января 2024');
    expect(text).toContain('Самая длинная серия: 3 дня');
  });

  it('пропускает блок даты при невалидной дате и берёт имя и фамилию', () => {
    const h = createHarness();
    const text = h.service.formatUserDetailMessage(
      personalUser({
        username: null as any,
        firstName: 'Анна',
        lastName: 'Смирнова',
        firstProposalDate: new Date('invalid'),
      }),
      2020
    );

    expect(text).toContain('Анна Смирнова');
    expect(text).not.toContain('Первый пост');
  });
});

describe('YearResultsService word declensions', () => {
  const cases: Array<[number, string]> = [
    [11, 'plural'],
    [1, 'one'],
    [2, 'few'],
    [5, 'plural'],
  ];
  const expectations: Record<string, Record<string, string>> = {
    getHoursWord: { plural: 'часов', one: 'час', few: 'часа' },
    getDaysWord: { plural: 'дней', one: 'день', few: 'дня' },
    getPostsWord: { plural: 'постов', one: 'пост', few: 'поста' },
    getMinutesWord: { plural: 'минут', one: 'минуту', few: 'минуты' },
    getAuthorsWord: { plural: 'авторов', one: 'автор', few: 'автора' },
    getTimesWord: { plural: 'раз', one: 'раз', few: 'раза' },
    getAppealWord: { plural: 'обращений', one: 'обращение', few: 'обращения' },
  };

  it.each(Object.keys(expectations))('%s склоняет все формы', (method) => {
    const h = createHarness();
    const fn = (h.service as any)[method];
    for (const [count, kind] of cases) {
      expect(fn(count)).toBe(expectations[method][kind]);
    }
  });
});

describe('YearResultsService.generateAndSendPreviewToOwner', () => {
  it('отправляет preview владельцу', async () => {
    const h = createHarness();
    const preview = { general: zeroGeneral({ year: 2024 }), users: [] };
    jest.spyOn(h.service, 'generateYearResults').mockResolvedValue(preview);
    h.bot.api.sendMessage.mockResolvedValue({ message_id: 1 });

    await h.service.generateAndSendPreviewToOwner(2024);

    expect(h.bot.api.sendMessage).toHaveBeenCalledWith(
      h.baseConfigService.ownerId,
      expect.stringContaining('Предпросмотр итогов 2024 года'),
      { parse_mode: 'HTML' }
    );
  });

  it('пробрасывает ошибку и логирует её', async () => {
    const h = createHarness();
    jest
      .spyOn(h.service, 'generateYearResults')
      .mockRejectedValue(new Error('boom'));
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    await expect(h.service.generateAndSendPreviewToOwner(2024)).rejects.toThrow('boom');
    expect(errorSpy).toHaveBeenCalled();
  });
});
