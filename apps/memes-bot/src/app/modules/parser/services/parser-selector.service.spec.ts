import {
  BACKLOG_TTL_DAYS,
  DUMP_COOLDOWN_MINUTES,
  DUMP_PER_SOURCE_CAP,
  DUMP_SIZE,
  ObservedStatus,
  POOL_TTL_DAYS,
} from '../constants/parser.constants';
import { ParserSelectorService } from './parser-selector.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const NOW = new Date('2026-09-19T12:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

const scoredRow = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  sourceChatId: '-1008888888888',
  mediaUniqueId: 'media-1',
  score: 5,
  status: ObservedStatus.SCORED,
  rejectReason: null,
  forced: false,
  createdAt: NOW,
  requestChannelMessageId: null,
  ...overrides,
});

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1008888888888',
  category: 'memes',
  status: 'active',
  excluded: false,
  err: null,
  weight: 1,
  ...overrides,
});

const makeObservedRepo = (): any => ({
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  save: jest.fn().mockImplementation(async (value) => value),
});

const makeRegistry = (): any => ({
  repository: {
    find: jest.fn().mockResolvedValue([source()]),
    save: jest.fn().mockResolvedValue(undefined),
  },
  markSourceIgnored: jest.fn().mockResolvedValue(undefined),
});

const makeDelivery = (): any => ({
  deliver: jest.fn().mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED }),
  attachMoreButton: jest.fn().mockResolvedValue(undefined),
  detachMoreButton: jest.fn().mockResolvedValue(undefined),
});

const makeSettings = (overrides: Record<string, unknown> = {}): any => ({
  current: { errMin: 0.15, ...overrides },
  enabled: true,
  boostActive: jest.fn(() => false),
});

const makeConfig = (): any => ({ userRequestMemeChannel: -1004444444444 });

const makeBot = (): any => ({
  api: {
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    editMessageCaption: jest.fn().mockResolvedValue(undefined),
  },
});

let clockNow = NOW;
const makeClock = (): any => ({ now: jest.fn(() => clockNow) });

const setup = (overrides: { settings?: Record<string, unknown> } = {}) => {
  const observedRepo = makeObservedRepo();
  const registry = makeRegistry();
  const delivery = makeDelivery();
  const clock = makeClock();
  const bot = makeBot();
  const settings = makeSettings(overrides.settings ?? {});
  const service = new ParserSelectorService(
    observedRepo,
    registry,
    delivery,
    settings,
    makeConfig(),
    bot,
    clock
  );
  (service as never as { pace: unknown }).pace = jest.fn().mockResolvedValue(undefined);
  return { service, observedRepo, registry, delivery, bot, clock, settings };
};

describe('ParserSelectorService', () => {
  beforeEach(() => {
    clockNow = NOW;
  });

  describe('deliverForced', () => {
    it('нет форс-постов → 0', async () => {
      const { service, delivery } = setup();
      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('доставляет форс-пост и переводит в DELIVERED', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);

      expect(await service.deliverForced()).toBe(1);
      expect(delivery.deliver).toHaveBeenCalledWith(row);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.SELECTED })
      );
    });

    it('исключённый источник пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow({ forced: true })]);
      registry.repository.find.mockResolvedValue([source({ excluded: true })]);

      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('низкий ERR источника пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow({ forced: true })]);
      registry.repository.find.mockResolvedValue([source({ err: 0.1 })]);

      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('транзиентный сбой доставки возвращает пост в SCORED', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);
      delivery.deliver.mockImplementation(async (candidate: any) => {
        candidate.rejectReason = 'send-failed';
        return { ok: false, status: ObservedStatus.FAILED };
      });

      expect(await service.deliverForced()).toBe(0);
      expect(observedRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ObservedStatus.SCORED, rejectReason: null })
      );
    });

    it('FAILED без rejectReason считается транзиентным', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);
      delivery.deliver.mockResolvedValue({ ok: false, status: ObservedStatus.FAILED });

      await service.deliverForced();

      expect(observedRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ObservedStatus.SCORED, rejectReason: null })
      );
    });

    it('терминальный сбой доставки переводит в REJECTED', async () => {
      const { service, observedRepo, delivery } = setup();
      const row = scoredRow({ forced: true });
      observedRepo.find.mockResolvedValue([row]);
      delivery.deliver.mockImplementation(async (candidate: any) => {
        candidate.rejectReason = 'media-too-large';
        return { ok: false, status: ObservedStatus.FAILED };
      });

      await service.deliverForced();

      expect(observedRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ObservedStatus.REJECTED })
      );
    });

    it('занято общим мьютексом → 0', async () => {
      const { service, observedRepo, delivery } = setup();
      (service as never as { busy: boolean }).busy = true;
      observedRepo.find.mockResolvedValue([scoredRow({ forced: true })]);

      expect(await service.deliverForced()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('применяет кап по источнику в пределах DUMP_SIZE', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      const chatIds = Array.from({ length: 7 }, (_, i) => `-1000${i}`);
      const rows: any[] = [];
      let id = 0;
      for (const chatId of chatIds) {
        for (let i = 0; i < 4; i += 1) {
          id += 1;
          rows.push(scoredRow({ id, forced: true, sourceChatId: chatId, mediaUniqueId: `m-${id}` }));
        }
      }
      observedRepo.find.mockResolvedValue(rows);
      registry.repository.find.mockResolvedValue(chatIds.map((chatId) => source({ chatId })));

      expect(await service.deliverForced()).toBe(DUMP_SIZE);
      const counts = new Map<string, number>();
      for (const call of delivery.deliver.mock.calls) {
        const key = call[0].sourceChatId;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(DUMP_PER_SOURCE_CAP);
      expect(counts.get('-10000')).toBe(DUMP_PER_SOURCE_CAP);
    });
  });

  describe('dumpMore', () => {
    it('без кандидатов → 0', async () => {
      const { service, delivery } = setup();
      expect(await service.dumpMore()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('занят → 0', async () => {
      const { service, observedRepo } = setup();
      (service as never as { busy: boolean }).busy = true;
      observedRepo.find.mockResolvedValue([scoredRow()]);
      expect(await service.dumpMore()).toBe(0);
    });

    it('cooldown между доборами → 0', async () => {
      const { service, observedRepo } = setup();
      (service as never as { lastDumpAt: number }).lastDumpAt = NOW.getTime();
      expect(await service.dumpMore()).toBe(0);
      expect(observedRepo.find).not.toHaveBeenCalled();
    });

    it('boost увеличивает лимит добора', async () => {
      const { service, observedRepo, settings } = setup();
      settings.boostActive.mockReturnValue(true);

      await service.dumpMore(5);

      expect(observedRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: Math.max(20 * 5, 20 + 20) })
      );
    });

    it('доставляет свежие первыми и ставит кнопку «Ещё 20»', async () => {
      const { service, observedRepo, delivery } = setup();
      const older = scoredRow({ id: 1, createdAt: daysAgo(2), score: 9, mediaUniqueId: 'older' });
      const newer = scoredRow({ id: 2, createdAt: NOW, score: 1, mediaUniqueId: 'newer' });
      observedRepo.find.mockResolvedValue([newer, older]);
      delivery.deliver.mockImplementation(async (row: any) => {
        row.requestChannelMessageId = 500 + row.id;
        return { ok: true, status: ObservedStatus.DELIVERED };
      });

      expect(await service.dumpMore()).toBe(2);
      expect(delivery.deliver.mock.calls[0][0].id).toBe(2);
      expect(delivery.attachMoreButton).toHaveBeenCalledWith(501, 1);
    });

    it('снимает кнопку с прошлой последней карточки, найденной в БД', async () => {
      const { service, observedRepo, delivery } = setup();
      let deliveredRows: any[] = [scoredRow({ id: 1, createdAt: NOW })];
      observedRepo.find.mockImplementation(async ({ where }: any) => {
        if (where?.status === ObservedStatus.DELIVERED) {
          return [{ id: 1, requestChannelMessageId: 501, status: ObservedStatus.DELIVERED }];
        }
        return deliveredRows;
      });
      delivery.deliver.mockImplementation(async (row: any) => {
        row.requestChannelMessageId = 500 + row.id;
        return { ok: true, status: ObservedStatus.DELIVERED };
      });

      await service.dumpMore();

      clockNow = new Date(NOW.getTime() + (DUMP_COOLDOWN_MINUTES + 1) * 60_000);
      deliveredRows = [scoredRow({ id: 2, createdAt: clockNow })];
      await service.dumpMore();

      expect(delivery.detachMoreButton).toHaveBeenCalledWith(501, 1);
      expect(delivery.attachMoreButton).toHaveBeenLastCalledWith(502, 2);
    });

    it('кандидат без источника в мапе пропускается', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow({ sourceChatId: '-100none' })]);
      registry.repository.find.mockResolvedValue([source({ chatId: '-1008888888888' })]);

      expect(await service.dumpMore()).toBe(0);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('без message_id кнопка «Ещё 20» не ставится', async () => {
      const { service, observedRepo, delivery } = setup();
      observedRepo.find.mockResolvedValue([scoredRow()]);
      delivery.deliver.mockResolvedValue({ ok: true, status: ObservedStatus.DELIVERED });

      expect(await service.dumpMore()).toBe(1);
      expect(delivery.attachMoreButton).not.toHaveBeenCalled();
    });

    it('исключённые источники и дубли медиа не доставляются', async () => {
      const { service, observedRepo, registry, delivery } = setup();
      observedRepo.find.mockResolvedValue([
        scoredRow({ id: 1, sourceChatId: '-100aaa', mediaUniqueId: 'dup', score: 3 }),
        scoredRow({ id: 2, sourceChatId: '-100bbb', mediaUniqueId: 'dup', score: 7 }),
        scoredRow({ id: 3, sourceChatId: '-100ccc', mediaUniqueId: 'unique' }),
      ]);
      registry.repository.find.mockResolvedValue([
        source({ chatId: '-100aaa' }),
        source({ chatId: '-100bbb', excluded: true }),
        source({ chatId: '-100ccc' }),
      ]);

      await service.dumpMore();

      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    });
  });

  describe('pickDiverse', () => {
    const pick = (service: ParserSelectorService, rows: any[], limit: number): any[] =>
      (service as never as { pickDiverse: (r: any[], l: number) => any[] }).pickDiverse(rows, limit);

    it('не более DUMP_PER_SOURCE_CAP постов одного источника, остаток из других', () => {
      const { service } = setup();
      const rows = [
        scoredRow({ id: 1, sourceChatId: '-100A' }),
        scoredRow({ id: 2, sourceChatId: '-100A' }),
        scoredRow({ id: 3, sourceChatId: '-100A' }),
        scoredRow({ id: 4, sourceChatId: '-100B' }),
        scoredRow({ id: 5, sourceChatId: '-100C' }),
        scoredRow({ id: 6, sourceChatId: '-100A' }),
        scoredRow({ id: 7, sourceChatId: '-100A' }),
        scoredRow({ id: 8, sourceChatId: '-100A' }),
      ];

      const picked = pick(service, rows, 5);

      expect(picked.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
      expect(picked.filter((row) => row.sourceChatId === '-100A')).toHaveLength(DUMP_PER_SOURCE_CAP);
    });

    it('если кап не даёт набрать limit — добирает из того же источника', () => {
      const { service } = setup();
      const rows = [
        scoredRow({ id: 1, sourceChatId: '-100A' }),
        scoredRow({ id: 2, sourceChatId: '-100A' }),
        scoredRow({ id: 3, sourceChatId: '-100A' }),
        scoredRow({ id: 4, sourceChatId: '-100A' }),
        scoredRow({ id: 5, sourceChatId: '-100A' }),
        scoredRow({ id: 6, sourceChatId: '-100A' }),
      ];

      const picked = pick(service, rows, 5);

      expect(picked).toHaveLength(5);
      expect(picked.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('кандидатов меньше limit — отдаёт всё', () => {
      const { service } = setup();
      const rows = [scoredRow({ id: 1 }), scoredRow({ id: 2 })];
      expect(pick(service, rows, 5)).toHaveLength(2);
    });

    it('останавливается, когда limit уже набран', () => {
      const { service } = setup();
      const rows = [
        scoredRow({ id: 1, sourceChatId: '-100A' }),
        scoredRow({ id: 2, sourceChatId: '-100A' }),
        scoredRow({ id: 3, sourceChatId: '-100A' }),
        scoredRow({ id: 4, sourceChatId: '-100B' }),
        scoredRow({ id: 5, sourceChatId: '-100C' }),
      ];

      const picked = pick(service, rows, 3);

      expect(picked.map((row) => row.id)).toEqual([1, 2, 3]);
    });
  });

  describe('ageBacklog', () => {
    it('карточки старше 7д удаляются и мягко игнорируются', async () => {
      const { service, observedRepo, registry, bot } = setup();
      const card = scoredRow({
        id: 1,
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: 321,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) => {
        if (where.status === ObservedStatus.DELIVERED) return [card];
        return [];
      });

      expect(await service.ageBacklog()).toBe(1);
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(-1004444444444, 321);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.EXPIRED, rejectReason: `backlog-${BACKLOG_TTL_DAYS}d` })
      );
      expect(registry.markSourceIgnored).toHaveBeenCalledWith('-1008888888888', false);
    });

    it('оценённый пул старше 14д истекает', async () => {
      const { service, observedRepo } = setup();
      const poolRow = scoredRow({ id: 2, createdAt: daysAgo(POOL_TTL_DAYS + 1) });
      observedRepo.find.mockImplementation(async ({ where }: any) => {
        if (where.status === ObservedStatus.SCORED) return [poolRow];
        return [];
      });

      expect(await service.ageBacklog()).toBe(1);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ObservedStatus.EXPIRED, rejectReason: `pool-${POOL_TTL_DAYS}d` })
      );
    });

    it('карточка без сообщения удаляется без вызова deleteMessage', async () => {
      const { service, observedRepo, bot } = setup();
      const card = scoredRow({
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: null,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.DELIVERED ? [card] : []
      );

      await service.ageBacklog();
      expect(bot.api.deleteMessage).not.toHaveBeenCalled();
    });

    it('ошибка удаления сообщения не роняет старение', async () => {
      const { service, observedRepo, bot } = setup();
      const card = scoredRow({
        status: ObservedStatus.DELIVERED,
        deliveredAt: daysAgo(BACKLOG_TTL_DAYS + 1),
        requestChannelMessageId: 321,
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.DELIVERED ? [card] : []
      );
      bot.api.deleteMessage.mockRejectedValue(new Error('gone'));

      await expect(service.ageBacklog()).resolves.toBe(1);
      expect(bot.api.editMessageCaption).toHaveBeenCalledWith(
        -1004444444444,
        321,
        expect.objectContaining({ caption: expect.stringContaining('Состарилось') })
      );
    });

    it('зависшие SELECTED без message_id возвращаются в SCORED', async () => {
      const { service, observedRepo } = setup();
      const stuck = scoredRow({
        id: 7,
        status: ObservedStatus.SELECTED,
        requestChannelMessageId: null,
        updatedAt: new Date(NOW.getTime() - 2 * 3_600_000),
      });
      observedRepo.find.mockImplementation(async ({ where }: any) =>
        where.status === ObservedStatus.SELECTED ? [stuck] : []
      );

      expect(await service.ageBacklog()).toBe(0);
      expect(observedRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7, status: ObservedStatus.SCORED })
      );
    });

  });

  it('pace реально ждёт (без подмены)', async () => {
    const { service } = setup();
    delete (service as never as { pace?: unknown }).pace;
    await expect((service as never as { pace: (ms: number) => Promise<void> }).pace(0)).resolves.toBeUndefined();
  });

  it('countBacklog считает DELIVERED', async () => {
    const { service, observedRepo } = setup();
    observedRepo.count.mockResolvedValue(4);
    expect(await service.countBacklog()).toBe(4);
    expect(observedRepo.count).toHaveBeenCalledWith({ where: { status: ObservedStatus.DELIVERED } });
  });

  it('deliverRows: источник отсутствует → кандидат отклоняется', async () => {
    const { service, observedRepo, delivery } = setup();
    const row = scoredRow();

    await (service as never as { deliverRows: (...args: unknown[]) => Promise<number> }).deliverRows([row], new Map(), false);

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.REJECTED, rejectReason: 'source-missing' })
    );
  });
});
