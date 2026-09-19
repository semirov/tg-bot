import { Logger } from '@nestjs/common';
import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  DuplicatePolicy,
  hasSimilarDistance,
  pickClosest,
  ScheduledPostCandidate,
  ScheduledPostsSource,
} from './duplicate-policy';

function makePolicy(options: {
  posts?: ScheduledPostCandidate[];
  postsReject?: Error;
  distances?: number[];
  loggerContext?: string;
} = {}) {
  const getAllScheduledPosts = options.postsReject
    ? jest.fn().mockRejectedValue(options.postsReject)
    : jest.fn().mockResolvedValue(options.posts ?? []);
  const calculateHashDistance = jest.fn();
  for (const distance of options.distances ?? []) {
    calculateHashDistance.mockReturnValueOnce(distance);
  }
  const source: ScheduledPostsSource = { getAllScheduledPosts };
  const policy =
    options.loggerContext === undefined
      ? new DuplicatePolicy(source, { calculateHashDistance })
      : new DuplicatePolicy(source, { calculateHashDistance }, options.loggerContext);

  return { policy, getAllScheduledPosts, calculateHashDistance };
}

describe('DUPLICATE_SIMILARITY_THRESHOLD', () => {
  it('равен 0.5', () => {
    expect(DUPLICATE_SIMILARITY_THRESHOLD).toBe(0.5);
  });
});

describe('hasSimilarDistance', () => {
  it('использует порог по умолчанию 0.5', () => {
    expect(hasSimilarDistance([{ distance: 0.5 }])).toBe(true);
    expect(hasSimilarDistance([{ distance: 0.49 }])).toBe(false);
  });

  it('уважает явно заданный порог', () => {
    expect(hasSimilarDistance([{ distance: 0.3 }], 0.3)).toBe(true);
    expect(hasSimilarDistance([{ distance: 0.3 }], 0.31)).toBe(false);
  });

  it('на пустом списке возвращает false', () => {
    expect(hasSimilarDistance([])).toBe(false);
  });
});

describe('pickClosest', () => {
  it('возвращает элемент с максимальным расстоянием', () => {
    const items = [
      { distance: 0.6, id: 'a' },
      { distance: 0.9, id: 'b' },
    ];
    expect(pickClosest(items)).toEqual({ distance: 0.9, id: 'b' });
  });

  it('при убывании расстояний оставляет первый', () => {
    const items = [
      { distance: 0.9, id: 'a' },
      { distance: 0.6, id: 'b' },
    ];
    expect(pickClosest(items)).toEqual({ distance: 0.9, id: 'a' });
  });

  it('при равных расстояниях оставляет последний (как исходный reduce)', () => {
    const items = [
      { distance: 0.9, id: 'a' },
      { distance: 0.9, id: 'b' },
    ];
    expect(pickClosest(items)).toEqual({ distance: 0.9, id: 'b' });
  });
});

describe('DuplicatePolicy', () => {
  beforeEach(() => {
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isValidDate', () => {
    it('отклоняет пустые и нулевые значения', () => {
      const { policy } = makePolicy();
      expect(policy.isValidDate(null)).toBe(false);
      expect(policy.isValidDate(undefined)).toBe(false);
      expect(policy.isValidDate(0)).toBe(false);
      expect(policy.isValidDate('')).toBe(false);
    });

    it('принимает Date, валидные строки и числа', () => {
      const { policy } = makePolicy();
      expect(policy.isValidDate(new Date())).toBe(true);
      expect(policy.isValidDate('2026-01-01')).toBe(true);
      expect(policy.isValidDate(1767225600000)).toBe(true);
    });

    it('отклоняет мусор', () => {
      const { policy } = makePolicy();
      expect(policy.isValidDate('definitely not a date')).toBe(false);
    });
  });

  describe('hasSimilar', () => {
    it('делегирует проверку порога', () => {
      const { policy } = makePolicy();
      expect(policy.hasSimilar([{ distance: 0.5 }])).toBe(true);
      expect(policy.hasSimilar([{ distance: 0.4 }])).toBe(false);
    });
  });

  describe('checkScheduledDuplicates', () => {
    it('без хеша возвращает null и не читает расписание', async () => {
      const { policy, getAllScheduledPosts } = makePolicy();
      await expect(policy.checkScheduledDuplicates('')).resolves.toBeNull();
      expect(getAllScheduledPosts).not.toHaveBeenCalled();
    });

    it('возвращает null, если источник вернул null', async () => {
      const getAllScheduledPosts = jest.fn().mockResolvedValue(null);
      const policy = new DuplicatePolicy(
        { getAllScheduledPosts },
        { calculateHashDistance: jest.fn() }
      );
      await expect(policy.checkScheduledDuplicates('h')).resolves.toBeNull();
    });

    it('возвращает null без запланированных постов', async () => {
      const { policy } = makePolicy({ posts: [] });
      await expect(policy.checkScheduledDuplicates('h')).resolves.toBeNull();
    });

    it('пропускает посты без хеша и без валидной даты', async () => {
      const { policy, calculateHashDistance } = makePolicy({
        posts: [
          { id: 1, hash: null, publishDate: new Date() },
          { id: 2, hash: 'a', publishDate: null },
          { id: 3, hash: 'b', publishDate: new Date('not-a-date') },
        ],
      });

      await expect(policy.checkScheduledDuplicates('h')).resolves.toBeNull();
      expect(calculateHashDistance).not.toHaveBeenCalled();
    });

    it('возвращает самый похожий пост не ниже порога', async () => {
      const { policy } = makePolicy({
        posts: [
          { id: 1, hash: 'a', publishDate: new Date('2026-01-01T00:00:00Z') },
          { id: 2, hash: 'b', publishDate: new Date('2026-02-01T00:00:00Z') },
        ],
        distances: [0.6, 0.9],
      });

      const result = await policy.checkScheduledDuplicates('h');

      expect(result).toEqual(
        expect.objectContaining({
          postId: 2,
          distance: 0.9,
          scheduledDate: new Date('2026-02-01T00:00:00Z'),
        })
      );
    });

    it('отбрасывает совпадения ниже порога', async () => {
      const { policy } = makePolicy({
        posts: [{ id: 1, hash: 'a', publishDate: new Date('2026-01-01T00:00:00Z') }],
        distances: [0.49],
      });

      await expect(policy.checkScheduledDuplicates('h')).resolves.toBeNull();
    });

    it('ловит ошибку загрузки расписания и логирует с явным контекстом', async () => {
      const { policy } = makePolicy({
        postsReject: new Error('db'),
        loggerContext: 'CustomContext',
      });

      await expect(policy.checkScheduledDuplicates('h')).resolves.toBeNull();
      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check scheduled duplicates: db'),
        'CustomContext'
      );
    });

    it('использует имя класса как контекст по умолчанию', async () => {
      const { policy } = makePolicy({ postsReject: new Error('boom') });

      await expect(policy.checkScheduledDuplicates('h')).resolves.toBeNull();
      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining('boom'),
        DuplicatePolicy.name
      );
    });
  });
});
