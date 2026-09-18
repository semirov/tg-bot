import { Logger } from '@nestjs/common';
import { MonthlyStatService, StatisticRequestType } from './monthly-stat.service';

const MEME_CHANNEL = -1003333333333;

function makeQb(result: any): any {
  const qb: any = {};
  [
    'leftJoinAndSelect',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'limit',
  ].forEach((method) => {
    qb[method] = jest.fn(() => qb);
  });
  qb.getRawMany = jest.fn().mockResolvedValue(result);
  return qb;
}

function createService(statistics: StatisticRequestType[] = []) {
  const qb = makeQb(statistics);
  const userRequestService = {
    repository: { createQueryBuilder: jest.fn(() => qb) },
  };
  const bot = {
    api: {
      getMe: jest.fn().mockResolvedValue({ username: 'meme_bot' }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 42 }),
      forwardMessage: jest.fn().mockResolvedValue(undefined),
    },
  };
  const baseConfigService = { memeChanelId: MEME_CHANNEL };

  const service = new MonthlyStatService(
    userRequestService as any,
    bot as any,
    baseConfigService as any
  );

  return { service, userRequestService, bot, baseConfigService, qb };
}

function stat(overrides: Partial<StatisticRequestType> = {}): StatisticRequestType {
  return {
    isAnonymousPublishing: false,
    userId: '101',
    username: 'vasya',
    firstName: 'Вася',
    lastName: 'Пупкин',
    count: '3',
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MonthlyStatService.getNameFromStatItem', () => {
  it('использует @username, когда он есть', () => {
    const { service } = createService();
    expect((service as any).getNameFromStatItem(stat({ username: 'vasya' }))).toBe('@vasya');
  });

  it('склеивает имя и фамилию без username', () => {
    const { service } = createService();
    expect(
      (service as any).getNameFromStatItem(
        stat({ username: '', firstName: 'Иван', lastName: 'Иванов' })
      )
    ).toBe('Иван Иванов');
  });

  it('пропускает пустую фамилию', () => {
    const { service } = createService();
    expect(
      (service as any).getNameFromStatItem(stat({ username: '', firstName: 'Пётр', lastName: '' }))
    ).toBe('Пётр');
  });

  it('возвращает пустую строку, когда нет ни username, ни имени', () => {
    const { service } = createService();
    expect(
      (service as any).getNameFromStatItem(
        stat({ username: '', firstName: '', lastName: '' })
      )
    ).toBe('');
  });
});

describe('MonthlyStatService.leaderBoardIconByIndex', () => {
  it.each([
    ['0', '🏅 '],
    ['1', '🥈 '],
    ['2', '🥉 '],
    ['3', ''],
    ['10', ''],
  ])('для индекса %s возвращает "%s"', (index, expected) => {
    const { service } = createService();
    expect((service as any).leaderBoardIconByIndex(index)).toBe(expected);
  });
});

describe('MonthlyStatService.getUserStatistic', () => {
  it('строит запрос с группировкой и получает сырые строки', async () => {
    const statistics = [stat()];
    const { service, qb } = createService(statistics);

    const result = await (service as any).getUserStatistic();

    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('userRequest.user', 'user');
    expect(qb.select).toHaveBeenCalledWith('user.id', 'userId');
    expect(qb.addSelect).toHaveBeenCalledWith('COUNT(userRequest.id)', 'count');
    expect(qb.where).toHaveBeenCalledWith('userRequest.isPublished = true');
    expect(qb.andWhere).toHaveBeenCalledWith('userRequest.publishedAt >= :date', {
      date: expect.any(Date),
    });
    expect(qb.groupBy).toHaveBeenCalledWith('user.id');
    expect(qb.orderBy).toHaveBeenCalledWith('count', 'DESC');
    expect(qb.limit).toHaveBeenCalledWith(10);
    expect(result).toBe(statistics);
  });
});

describe('MonthlyStatService.publishMonthlyStatistic', () => {
  it('формирует текст с иконками, публикует и рассылает личную статистику', async () => {
    const statistics = [
      stat({ username: 'vasya', count: '5' }),
      stat({ userId: '102', username: '', firstName: 'Иван', lastName: 'Иванов', count: '2' }),
    ];
    const { service, bot, qb } = createService(statistics);
    const personalSpy = jest
      .spyOn(service as any, 'sendPersonalStatistic')
      .mockResolvedValue(undefined);

    await service.publishMonthlyStatistic();

    expect(qb.getRawMany).toHaveBeenCalledTimes(1);
    expect(bot.api.getMe).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = bot.api.sendMessage.mock.calls[0];
    expect(chatId).toBe(MEME_CHANNEL);
    expect(text).toContain('@vasya - 5');
    expect(text).toContain('🏅 @vasya - 5');
    expect(text).toContain('🥈 Иван Иванов - 2');
    expect(text).toContain('#статистика');
    expect(options).toEqual(
      expect.objectContaining({ reply_markup: expect.anything() })
    );
    expect(personalSpy).toHaveBeenCalledWith(statistics, 42);
  });

  it('публикует сообщение и при пустой статистике', async () => {
    const { service, bot } = createService([]);
    const personalSpy = jest
      .spyOn(service as any, 'sendPersonalStatistic')
      .mockResolvedValue(undefined);

    await service.publishMonthlyStatistic();

    expect(bot.api.getMe).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(personalSpy).toHaveBeenCalledWith([], 42);
  });
});

describe('MonthlyStatService.sendPersonalStatistic', () => {
  it('отправляет личное сообщение и пересылает статистику каждому пользователю', async () => {
    const statistics = [stat({ userId: '101', count: '7' }), stat({ userId: '202', count: '1' })];
    const { service, bot } = createService();

    await (service as any).sendPersonalStatistic(statistics, 42);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(1, '101', expect.stringContaining('постов - 7'));
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      1,
      '101',
      expect.stringContaining('место в общем рейтинге - 1')
    );
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(
      2,
      '202',
      expect.stringContaining('место в общем рейтинге - 2')
    );
    expect(bot.api.forwardMessage).toHaveBeenNthCalledWith(1, 101, MEME_CHANNEL, 42);
    expect(bot.api.forwardMessage).toHaveBeenNthCalledWith(2, 202, MEME_CHANNEL, 42);
  });

  it('продолжает рассылку, если одному пользователю написать не удалось', async () => {
    const statistics = [stat({ userId: '101' }), stat({ userId: '202' })];
    const { service, bot } = createService();
    bot.api.sendMessage.mockRejectedValueOnce(new Error('user blocked')).mockResolvedValueOnce({
      message_id: 1,
    });

    await (service as any).sendPersonalStatistic(statistics, 42);

    expect(console.error).toHaveBeenCalledWith(
      '[Error while sent personal statistic]',
      expect.any(Error)
    );
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.forwardMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.forwardMessage).toHaveBeenCalledWith(202, MEME_CHANNEL, 42);
  });

  it('ничего не делает при пустом списке', async () => {
    const { service, bot } = createService();

    await (service as any).sendPersonalStatistic([], 42);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.forwardMessage).not.toHaveBeenCalled();
  });
});
