import {
  UserYearStatistics,
  YearGeneralStatistics,
  YearResultsPreview,
} from '../interfaces/year-statistics.interface';
import { YearResultsFormatter } from './year-results.formatter';

const NOW = new Date('2024-06-15T12:00:00.000Z');

function general(overrides: Partial<YearGeneralStatistics> = {}): YearGeneralStatistics {
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

function user(overrides: Partial<UserYearStatistics> = {}): UserYearStatistics {
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

describe('YearResultsFormatter склонения', () => {
  const expectations: Record<string, Record<number, string>> = {
    getHoursWord: { 1: 'час', 2: 'часа', 5: 'часов', 11: 'часов' },
    getDaysWord: { 1: 'день', 2: 'дня', 5: 'дней', 11: 'дней' },
    getPostsWord: { 1: 'пост', 2: 'поста', 5: 'постов', 11: 'постов' },
    getMinutesWord: { 1: 'минуту', 2: 'минуты', 5: 'минут', 11: 'минут' },
    getAuthorsWord: { 1: 'автор', 2: 'автора', 5: 'авторов', 11: 'авторов' },
    getTimesWord: { 1: 'раз', 2: 'раза', 5: 'раз', 11: 'раз' },
    getAppealWord: { 1: 'обращение', 2: 'обращения', 5: 'обращений', 11: 'обращений' },
  };

  it.each(Object.keys(expectations))('%s выбирает формы', (method) => {
    const fn = (YearResultsFormatter as any)[method] as (count: number) => string;
    for (const count of [1, 2, 5, 11]) {
      expect(fn(count)).toBe(expectations[method][count]);
    }
  });
});

describe('YearResultsFormatter.formatGeneralStatistics', () => {
  const formatter = new YearResultsFormatter();

  it('печатает минимальный текст и заканчивается хэштегом', () => {
    const text = formatter.formatGeneralStatistics(general(), []);

    expect(text).toContain('🎉 <b>Итоги 2024 года</b>');
    expect(text).toContain('опубликовано <b>0</b> постов');
    expect(text).not.toContain('обсерваторией');
    expect(text).not.toContain('Пользователи предложили');
    expect(text.endsWith('#итоги_года')).toBe(true);
  });

  it('печатает единичные формы и обсерваторию', () => {
    const text = formatter.formatGeneralStatistics(
      general({
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
      }),
      [{ totalPublished: 1, totalCringe: 1, totalProposed: 10 }]
    );

    expect(text).toContain('был найден обсерваторией');
    expect(text).toContain('создавал контент');
    expect(text).toContain('на <b>1</b> обращение');
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

  it('печатает множественные формы, лидеров и NEXT_INTERVAL скрыт', () => {
    const text = formatter.formatGeneralStatistics(
      general({
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
      }),
      [
        { totalProposed: 10, totalPublished: 9, totalCringe: 4 },
        { totalProposed: 20, totalPublished: 2, totalCringe: 1 },
      ]
    );

    expect(text).toContain('были найдены обсерваторией');
    expect(text).toContain('были опубликованы');
    expect(text).toContain('Самым активным месяцем стали');
    expect(text).toContain('попали');
    expect(text).toContain('оказались дубликатами');
    expect(text).toContain('попадают в публикацию');
    expect(text).toContain('публикуются');
    expect(text).toContain('людям были');
    expect(text).not.toContain('NEXT_INTERVAL');
    expect(text).toContain('за <b>2</b> часа');
    expect(text).toContain('и <b>2</b> часа');
    expect(text).toContain('ожидали своей очереди');
  });

  it('печатает только дубликаты без кринжа', () => {
    const text = formatter.formatGeneralStatistics(
      general({
        totalMemes: 10,
        totalProposedByUsers: 10,
        memesFromUsers: 0,
        cringeMemes: 0,
        duplicatesFound: 2,
        duplicatesPercentage: 20,
        topDuplicateUser: { duplicatesCount: 2, duplicatesPercentage: 50 } as any,
        textMessagesToAdmin: 2,
        adminRepliedToMessages: 0,
      }),
      []
    );

    expect(text).toContain('Система нашла <b>2</b> дубликатов');
    expect(text).toContain('оказались дубликатами');
    expect(text).toContain('были дубликатами');
    expect(text).toContain('написали');
    expect(text).not.toContain('обсерваторией');
  });

  it('не печатает остаток часов при ровных сутках', () => {
    const text = formatter.formatGeneralStatistics(
      general({
        totalMemes: 1,
        totalProposedByUsers: 1,
        memesFromUsers: 1,
        averageTimeFromModerationToPublication: 48,
        longestQueueDate: new Date('2024-05-01'),
        longestQueueLength: 3,
      }),
      []
    );

    expect(text).toContain('проходило <b>2</b> дня');
    expect(text).not.toContain('и <b>0</b>');
    expect(text).toContain('ожидали своей очереди');
  });

  it('не печатает лидеров, когда их показатели нулевые', () => {
    const text = formatter.formatGeneralStatistics(general({ totalMemes: 1 }), [
      { totalProposed: 20, totalPublished: 0, totalCringe: 0 },
      { totalProposed: 10, totalPublished: 0, totalCringe: 0 },
    ]);

    expect(text).not.toContain('мемный мастер');
    expect(text).not.toContain('кринж-кинг');
    expect(text).not.toContain('синергию');
    expect(text).not.toContain('упорный подписчик');
  });
});

describe('YearResultsFormatter.formatPreviewMessage', () => {
  const formatter = new YearResultsFormatter();

  it('выводит не более десяти пользователей', () => {
    const users = Array.from({ length: 12 }, (_, i) =>
      user({ userId: i + 1, username: `u${i + 1}` })
    );
    const preview: YearResultsPreview = {
      general: general({
        year: 2024,
        totalMemes: 1,
        memesFromUsers: 1,
        cringeMemes: 2,
        duplicatesFound: 3,
      }),
      users,
    };

    const text = formatter.formatPreviewMessage(preview);

    expect(text).toContain('Предпросмотр итогов 2024 года');
    expect(text).toContain('Пользователи (12)');
    expect(text).toContain('... и еще 2 пользователей');
    expect(text).toContain('10. @u10');
    expect(text).not.toContain('11. @u11');
  });

  it('выводит имя без username и без хвоста', () => {
    const text = formatter.formatPreviewMessage({
      general: general({ year: 2023 }),
      users: [user({ username: '', firstName: 'Пётр', lastName: 'Петров' })],
    });

    expect(text).toContain('1. Пётр Петров - 10 постов');
    expect(text).not.toContain('... и еще');
  });
});

describe('YearResultsFormatter.formatUserDetailMessage', () => {
  const formatter = new YearResultsFormatter();

  it('печатает детали с валидной датой и username', () => {
    const text = formatter.formatUserDetailMessage(
      user({ username: 'vasya', firstProposalDate: new Date('2024-01-05'), longestStreak: 3 }),
      2024
    );

    expect(text).toContain('👤 <b>@vasya</b>');
    expect(text).toContain('Статистика за 2024 год');
    expect(text).toContain('Первый пост: 5 января 2024');
    expect(text).toContain('Самая длинная серия: 3 дня');
  });

  it('пропускает блок даты при невалидной дате и берёт имя и фамилию', () => {
    const text = formatter.formatUserDetailMessage(
      user({
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

describe('YearResultsFormatter.formatPersonalMessage', () => {
  const formatter = new YearResultsFormatter();

  it('печатает все блоки для отличного пользователя', () => {
    const text = formatter.formatPersonalMessage(
      user({
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
      10,
      NOW
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

  it('обрабатывает невалидную дату, часы и «неплохо»', () => {
    const text = formatter.formatPersonalMessage(
      user({
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
      10,
      NOW
    );

    expect(text).toContain('За этот год ты предложил');
    expect(text).toContain('были опубликованы');
    expect(text).toContain('неплохо');
    expect(text).toContain('через <b>2</b> дня');
    expect(text).not.toContain('попал в кринж');
  });

  it('предупреждает о большом проценте дубликатов и низком одобрении', () => {
    const text = formatter.formatPersonalMessage(
      user({
        totalCringe: 3,
        approvalRate: 30,
        averageTimeToPublication: 0,
        duplicatesCount: 12,
        duplicatesPercentage: 60,
      }),
      2024,
      5,
      100,
      NOW
    );

    expect(text).toContain('попали в кринж');
    expect(text).toContain('главное участие');
    expect(text).toContain('стоит проверять посты перед отправкой');
    expect(text).not.toContain('В среднем твои посты');
  });

  it('не показывает процент дубликатов при нуле и печатает "дубликат"', () => {
    const text = formatter.formatPersonalMessage(
      user({
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
      100,
      NOW
    );

    expect(text).toContain('<b>1</b> пост-дубликат');
    expect(text).not.toContain('%</b>)');
  });

  it('считает часы через дни, когда среднее больше суток', () => {
    const text = formatter.formatPersonalMessage(
      user({
        totalCringe: 0,
        activeDays: 0,
        approvalRate: undefined,
        averageTimeToPublication: 24,
        mostActiveTimeOfDay: undefined,
        duplicatesCount: 0,
      }),
      2024,
      5,
      100,
      NOW
    );

    expect(text).toContain('через <b>1</b> день');
  });

  it('печатает серию в один день во множественной форме', () => {
    const text = formatter.formatPersonalMessage(
      user({ activeDays: 5, longestStreak: 5, duplicatesCount: 0 }),
      2024,
      5,
      100,
      NOW
    );

    expect(text).toContain('самая длинная серия составила <b>5</b> дней подряд');
  });
});
