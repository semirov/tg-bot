import { YearStatisticsQuery } from './year-statistics.query';

/**
 * Хелперы для ручных моков TypeORM, аналогичные спеке сервиса: все запросы идут
 * последовательно, терминальные методы забирают значения из очереди репозитория.
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
  };
  repo.createQueryBuilder = jest.fn(() => {
    const qb = makeQueryBuilder();
    const next = () => Promise.resolve(repo._qbQueue.length ? repo._qbQueue.shift() : undefined);
    qb.getCount = jest.fn(next);
    qb.getRawOne = jest.fn(next);
    qb.getRawMany = jest.fn(next);
    return qb;
  });
  return repo;
}

function seed(repo: any, values: any[]): void {
  repo._qbQueue.push(...values);
}

function createQuery() {
  const userRequestRepository = makeRepo();
  const cringePostRepository = makeRepo();
  const postSchedulerRepository = makeRepo();
  const observatoryPostRepository = makeRepo();

  const query = new YearStatisticsQuery(
    userRequestRepository,
    cringePostRepository,
    postSchedulerRepository,
    observatoryPostRepository
  );

  return {
    query,
    userRequestRepository,
    cringePostRepository,
    postSchedulerRepository,
    observatoryPostRepository,
  };
}

describe('YearStatisticsQuery.collectGeneralStatistics', () => {
  it('собирает все показатели за год', async () => {
    const h = createQuery();
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
    seed(h.observatoryPostRepository, [10]);
    seed(h.postSchedulerRepository, [
      30, // memesFromObservatory
      { mode: 'NEXT_MORNING' }, // publicationModes
      { date: '2024-05-01', queue_length: '7' }, // longestQueue
    ]);
    seed(h.cringePostRepository, [4]);

    const result = await h.query.collectGeneralStatistics(2024);

    expect(result).toEqual({
      totalModeratedMessages: 110,
      totalMemes: 70,
      memesFromUsers: 40,
      memesFromObservatory: 30,
      totalProposedByUsers: 100,
      textMessagesToAdmin: 30,
      adminRepliedToMessages: 20,
      adminReplyPercentage: 67,
      cringeMemes: 4,
      duplicatesFound: 5,
      year: 2024,
      totalAuthors: 12,
      activeDaysWithMemes: 2,
      mostProductiveDay: new Date('2024-03-01'),
      mostProductiveDayCount: 3,
      mostActiveMonth: 'март',
      mostActiveMonthCount: 40,
      leastActiveMonth: 'июль',
      leastActiveMonthCount: 5,
      mostPopularPublicationMode: 'утро',
      duplicatesPercentage: 5,
      averageTimeToModeration: 30,
      averageTimeFromModerationToPublication: 5,
      longestQueueDate: new Date('2024-05-01'),
      longestQueueLength: 7,
      topDuplicateUser: {
        username: 'vasya',
        firstName: 'Вася',
        lastName: 'Пупкин',
        duplicatesCount: 3,
        duplicatesPercentage: 30,
      },
    });
  });

  it('возвращает нули и undefined когда данных нет', async () => {
    const h = createQuery();
    seed(h.userRequestRepository, [
      0,
      0,
      0,
      0,
      0,
      undefined,
      [],
      [],
      0,
      undefined,
      undefined,
      undefined,
    ]);
    seed(h.observatoryPostRepository, [0]);
    seed(h.postSchedulerRepository, [0, undefined, undefined]);
    seed(h.cringePostRepository, [0]);

    const result = await h.query.collectGeneralStatistics(2024);

    expect(result.totalModeratedMessages).toBe(0);
    expect(result.totalMemes).toBe(0);
    expect(result.adminReplyPercentage).toBe(0);
    expect(result.totalAuthors).toBe(0);
    expect(result.activeDaysWithMemes).toBe(0);
    expect(result.mostProductiveDay).toBeUndefined();
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

  it('обрабатывает единственный месяц и неизвестный режим', async () => {
    const h = createQuery();
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
    seed(h.postSchedulerRepository, [
      0,
      { mode: 'CUSTOM_MODE' },
      { date: '2024-02-02', queue_length: '3' },
    ]);
    seed(h.cringePostRepository, [0]);

    const result = await h.query.collectGeneralStatistics(2024);

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

describe('YearStatisticsQuery.collectUserStatistics', () => {
  function seedUserStats(h: ReturnType<typeof createQuery>) {
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
      [
        { date: '2024-01-01', count: '1' },
        { date: '2024-01-02', count: '1' },
        { date: '2024-01-04', count: '3' },
        { date: '2024-01-05', count: '5' },
      ],
      { avgHours: '10' },
      { hour: '9' },
      1,
      [],
      null,
      { hour: '15' },
      0,
      [{ date: '2024-03-01', count: '1' }],
      { avgHours: '0' },
      { hour: '20' },
      2,
      [
        { date: '2024-04-01', count: '1' },
        { date: '2024-04-03', count: '1' },
        { date: '2024-04-05', count: '2' },
      ],
      { avgHours: null },
      { hour: '2' },
      0,
      [{ date: '2024-05-01', count: '1' }],
      undefined,
      null,
      0,
      [],
      null,
      null,
      0,
    ]);
    seed(h.cringePostRepository, [2, 0, 1, 0, 0, 0]);
  }

  it('считает персональную статистику по каждому пользователю', async () => {
    const h = createQuery();
    seedUserStats(h);

    const result = await h.query.collectUserStatistics(2024);

    expect(result).toHaveLength(6);

    expect(result[0]).toMatchObject({
      userId: 1,
      totalProposed: 12,
      totalPublished: 8,
      totalRejected: 2,
      totalCringe: 2,
      activeDays: 4,
      longestStreak: 2,
      mostProductiveDayCount: 5,
      approvalRate: 67,
      averageTimeToPublication: 10,
      mostActiveTimeOfDay: 'утром',
      duplicatesCount: 1,
      duplicatesPercentage: 8,
    });
    expect(result[0].mostProductiveDay).toEqual(new Date('2024-01-05'));
    expect(result[0].firstProposalDate).toEqual(new Date('2024-01-05'));

    expect(result[1].activeDays).toBe(0);
    expect(result[1].longestStreak).toBe(0);
    expect(result[1].mostProductiveDay).toBeUndefined();
    expect(result[1].averageTimeToPublication).toBeUndefined();
    expect(result[1].mostActiveTimeOfDay).toBe('днём');
    expect(result[1].totalRejected).toBe(0);

    expect(result[2].mostActiveTimeOfDay).toBe('вечером');
    expect(result[2].averageTimeToPublication).toBe(0);

    expect(result[3].mostActiveTimeOfDay).toBe('ночью');
    expect(result[3].averageTimeToPublication).toBeUndefined();
    expect(result[3].longestStreak).toBe(1);

    expect(result[4].mostActiveTimeOfDay).toBeUndefined();

    expect(result[5].approvalRate).toBe(0);
    expect(result[5].duplicatesPercentage).toBe(0);
  });

  it('возвращает пустой массив если пользователей нет', async () => {
    const h = createQuery();
    seed(h.userRequestRepository, [[]]);

    await expect(h.query.collectUserStatistics(2024)).resolves.toEqual([]);
  });
});
