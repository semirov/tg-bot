import { QueueAlertLevel, QueueAlertService } from './queue-alert.service';

const msk = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 3, mi));

function setup(
  options: {
    count?: number;
    furthest?: Date | null;
    state?: { level: string; sentAt: Date } | null;
    findOneRejects?: boolean;
  } = {}
) {
  const postSchedulerService = {
    countUpcoming: jest.fn().mockResolvedValue(options.count ?? 0),
    getFurthestUpcoming: jest
      .fn()
      .mockResolvedValue(options.furthest ? { publishDate: options.furthest } : null),
  };
  const repository = {
    findOne: options.findOneRejects
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue(options.state ?? null),
    save: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const bot = { api: { sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }) } };
  const config = { ownerId: 4242 };

  const service = new QueueAlertService(
    postSchedulerService as never,
    repository as never,
    bot as never,
    config as never
  );

  return { service, postSchedulerService, repository, bot };
}

describe('QueueAlertService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('evaluate', () => {
    it('пустая очередь → EMPTY без дальнего поста', async () => {
      const { service, postSchedulerService } = setup({ count: 0 });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot).toEqual({
        level: QueueAlertLevel.EMPTY,
        days: null,
        count: 0,
        until: null,
      });
      expect(postSchedulerService.getFurthestUpcoming).not.toHaveBeenCalled();
    });

    it('дальний пост через 2 дня → THREE_DAYS', async () => {
      const { service } = setup({ count: 4, furthest: msk(2026, 5, 12, 12) });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot.level).toBe(QueueAlertLevel.THREE_DAYS);
      expect(snapshot.days).toBeCloseTo(2);
      expect(snapshot.until).toEqual(msk(2026, 5, 12, 12));
    });

    it('дальний пост ровно через 3 дня → THREE_DAYS (граница)', async () => {
      const { service } = setup({ count: 4, furthest: msk(2026, 5, 13, 12) });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot.level).toBe(QueueAlertLevel.THREE_DAYS);
    });

    it('дальний пост через 12 часов → ONE_DAY', async () => {
      const { service } = setup({ count: 2, furthest: msk(2026, 5, 11, 0) });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot.level).toBe(QueueAlertLevel.ONE_DAY);
    });

    it('дальний пост через 10 дней → HEALTHY', async () => {
      const { service } = setup({ count: 50, furthest: msk(2026, 5, 20, 12) });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot.level).toBe(QueueAlertLevel.HEALTHY);
    });

    it('просроченные посты (дальний в прошлом) → ONE_DAY, но не EMPTY', async () => {
      const { service } = setup({ count: 1, furthest: msk(2026, 5, 9, 12) });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot.level).toBe(QueueAlertLevel.ONE_DAY);
      expect(snapshot.days).toBe(0);
    });

    it('count>0, но дальнего поста нет → ONE_DAY', async () => {
      const { service } = setup({ count: 1, furthest: null });
      const snapshot = await service.evaluate(msk(2026, 5, 10, 12));
      expect(snapshot.level).toBe(QueueAlertLevel.ONE_DAY);
      expect(snapshot.days).toBe(0);
    });
  });

  describe('isWithinWindow', () => {
    const { service } = setup();
    it('днём 10:00 — можно', () => {
      expect(service.isWithinWindow(msk(2026, 5, 10, 10))).toBe(true);
    });
    it('граница 09:00 — можно', () => {
      expect(service.isWithinWindow(msk(2026, 5, 10, 9))).toBe(true);
    });
    it('граница 23:00 — уже нельзя', () => {
      expect(service.isWithinWindow(msk(2026, 5, 10, 23))).toBe(false);
    });
    it('ночью 02:00 — нельзя', () => {
      expect(service.isWithinWindow(msk(2026, 5, 10, 2))).toBe(false);
    });
  });

  describe('check', () => {
    it('HEALTHY ничего не шлёт и не трогает состояние', async () => {
      const { service, bot, repository } = setup({ count: 5, furthest: msk(2026, 5, 25, 12) });
      await service.check(msk(2026, 5, 10, 12));
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('HEALTHY после алерта сбрасывает сохранённое состояние', async () => {
      const { service, repository } = setup({ count: 5, furthest: msk(2026, 5, 25, 12) });
      (service as never as { lastLevel: string }).lastLevel = QueueAlertLevel.THREE_DAYS;
      await service.check(msk(2026, 5, 10, 12));
      expect(repository.delete).toHaveBeenCalledWith({ id: 1 });
    });

    it('ночью алерт не отправляется', async () => {
      const { service, bot } = setup({ count: 1, furthest: msk(2026, 5, 10, 20) });
      await service.check(msk(2026, 5, 11, 2));
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('днём при плохом уровне шлёт владельцу и сохраняет состояние', async () => {
      const now = msk(2026, 5, 10, 12);
      const { service, bot, repository } = setup({ count: 1, furthest: msk(2026, 5, 10, 20) });
      await service.check(now);
      expect(bot.api.sendMessage).toHaveBeenCalledWith(4242, expect.stringContaining('1 день'));
      expect(repository.save).toHaveBeenCalledWith({
        id: 1,
        level: QueueAlertLevel.ONE_DAY,
        sentAt: now,
      });
    });

    it('повторный тот же уровень в течение суток не шлётся', async () => {
      const now = msk(2026, 5, 10, 12);
      const { service, bot } = setup({ count: 1, furthest: msk(2026, 5, 10, 20) });
      await service.check(now);
      bot.api.sendMessage.mockClear();
      await service.check(msk(2026, 5, 10, 20));
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('тот же уровень спустя сутки шлётся снова', async () => {
      const { service, bot } = setup({ count: 1, furthest: msk(2026, 5, 11, 20) });
      await service.check(msk(2026, 5, 10, 12));
      bot.api.sendMessage.mockClear();
      await service.check(msk(2026, 5, 11, 12));
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('ухудшение уровня шлётся сразу, даже если недавно слали', async () => {
      const { service, bot, postSchedulerService } = setup();
      postSchedulerService.countUpcoming.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      postSchedulerService.getFurthestUpcoming.mockResolvedValueOnce({
        publishDate: msk(2026, 5, 11, 12),
      });
      await service.check(msk(2026, 5, 10, 12));
      bot.api.sendMessage.mockClear();
      await service.check(msk(2026, 5, 10, 13));
      expect(bot.api.sendMessage).toHaveBeenCalledWith(4242, expect.stringContaining('пуста'));
    });

    it('ошибка отправки логируется и состояние не пишется', async () => {
      const { service, repository, bot } = setup({ count: 1, furthest: msk(2026, 5, 10, 20) });
      bot.api.sendMessage.mockRejectedValue(new Error('bot blocked'));
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      await service.check(msk(2026, 5, 10, 12));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bot blocked'));
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('ошибка сохранения состояния не роняет проверку', async () => {
      const { service, repository } = setup({ count: 1, furthest: msk(2026, 5, 10, 20) });
      repository.save.mockRejectedValue(new Error('db down'));
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      await service.check(msk(2026, 5, 10, 12));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });
  });

  describe('onModuleInit', () => {
    it('подхватывает сохранённое состояние', async () => {
      const sentAt = msk(2026, 5, 10, 12);
      const { service } = setup({
        state: { level: QueueAlertLevel.ONE_DAY, sentAt },
      });
      await service.onModuleInit();
      expect(service['lastLevel']).toBe(QueueAlertLevel.ONE_DAY);
      expect(service['lastSentAt']).toBe(sentAt);
    });

    it('без записи состояние пустое', async () => {
      const { service } = setup({ state: null });
      await service.onModuleInit();
      expect(service['lastLevel']).toBeNull();
    });

    it('ошибка чтения логируется', async () => {
      const { service } = setup({ findOneRejects: true });
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      await service.onModuleInit();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });
  });

  describe('buildMessage', () => {
    const { service } = setup();

    it('EMPTY', () => {
      const text = service.buildMessage({
        level: QueueAlertLevel.EMPTY,
        days: null,
        count: 0,
        until: null,
      });
      expect(text).toContain('пуста');
    });

    it('ONE_DAY с датой и склонением', () => {
      const text = service.buildMessage({
        level: QueueAlertLevel.ONE_DAY,
        days: 0.5,
        count: 2,
        until: msk(2026, 5, 10, 20),
      });
      expect(text).toContain('1 день');
      expect(text).toContain('2 поста');
      expect(text).toContain('10.05 в 20:00');
    });

    it('THREE_DAYS со склонением «постов»', () => {
      const text = service.buildMessage({
        level: QueueAlertLevel.THREE_DAYS,
        days: 2,
        count: 11,
        until: msk(2026, 5, 12, 12),
      });
      expect(text).toContain('~3 дня');
      expect(text).toContain('11 постов');
    });

    it('ONE_DAY без даты (нет достоверного времени)', () => {
      const text = service.buildMessage({
        level: QueueAlertLevel.ONE_DAY,
        days: 0,
        count: 1,
        until: null,
      });
      expect(text).toContain('1 пост');
      expect(text).toContain('свободных слотов почти не осталось');
    });
  });
});
