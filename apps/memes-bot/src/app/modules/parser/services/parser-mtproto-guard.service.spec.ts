import { Logger } from '@nestjs/common';
import {
  ParserMtprotoGuard,
  TerminalMtprotoError,
  entityBackoffMs,
} from './parser-mtproto-guard.service';
import {
  ENTITY_BACKOFF_CAP_MS,
  ENTITY_BROKEN_RETRY_MS,
  ENTITY_REFRESH_COOLDOWN_MS,
} from '../constants/parser.constants';
import { mtprotoFloodGate } from '../../../shared/mtproto-flood-gate';

const NOW = new Date('2026-10-25T00:00:00Z').getTime();

const makeBot = (): any => ({ api: { sendMessage: jest.fn().mockResolvedValue(undefined) } });
const makeConfig = (): any => ({ ownerId: 1 });
const makeRandom = (): any => ({ next: jest.fn().mockReturnValue(0) });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** gramjs: errorMessage = FLOOD, текст — «A wait of N seconds is required». */
const floodError = (seconds: number): Error => {
  const error = new Error(`RPCError 420: FLOOD_WAIT_${seconds}`);
  (error as { errorMessage?: string }).errorMessage = `FLOOD_WAIT_${seconds}`;
  return error;
};

/** Реальный вид FloodWaitError из gramjs: «A wait of N seconds is required (caused by …)». */
const floodWaitText = (seconds: number, cause = 'contacts.ResolveUsername'): Error => {
  const error = new Error(`A wait of ${seconds} seconds is required (caused by ${cause})`);
  (error as { errorMessage?: string }).errorMessage = 'FLOOD';
  return error;
};

const channelInvalid = (): Error => {
  const error = new Error('RPCError 400: CHANNEL_INVALID (caused by channels.GetChannels)');
  (error as { errorMessage?: string }).errorMessage = 'CHANNEL_INVALID';
  return error;
};

const inputEntityMiss = (): Error => new Error('Could not find the input entity for PeerChannel');

/** Фейковый MTProto-клиент: кэш сущностей gramjs (память + строки сессии). */
const makeEntityClient = (chatId: string): any => {
  const cacheMap = new Map<string, unknown>([[chatId, { className: 'InputPeerChannel' }]]);
  const entities = new Set<unknown[]>([[chatId, 'hash', 'chan', null, 'Chan']]);
  const getDialogs = jest.fn().mockResolvedValue([]);
  return {
    getDialogs,
    client: () => ({
      _entityCache: { cacheMap },
      session: { _entities: entities },
      getDialogs,
    }),
  };
};

describe('ParserMtprotoGuard', () => {
  let guard: ParserMtprotoGuard;
  let bot: any;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mtprotoFloodGate.reset();
    bot = makeBot();
    guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom());
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mtprotoFloodGate.reset();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('успешная операция проходит без ретраев', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(guard.run('op', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(guard.isBlocked()).toBe(false);
    expect(guard.blockedUntil()).toBeNull();
  });

  it('FLOOD_WAIT_123 → пауза до дедлайна, Telegram до него не трогаем', async () => {
    const failing = jest.fn().mockRejectedValue(floodError(123));
    await expect(guard.run('getHistory', failing)).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(guard.blockedUntil()).toBe(NOW + 123_000);

    const later = jest.fn().mockResolvedValue('ok');
    jest.advanceTimersByTime(122_000);
    await expect(guard.run('getMessages:eval', later)).resolves.toBeUndefined();
    expect(later).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_001);
    await expect(guard.run('getMessages:eval', later)).resolves.toBe('ok');
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('«A wait of 50000 seconds» (15 часов) не игнорируется и не даёт ни одного вызова', async () => {
    const failing = jest.fn().mockRejectedValue(floodWaitText(50_000));
    await guard.run('getHistory', failing);

    expect(guard.isBlocked()).toBe(true);
    expect(guard.blockedUntil()).toBe(NOW + 50_000_000);

    const probe = jest.fn().mockResolvedValue([]);
    for (let i = 0; i < 5; i += 1) {
      await guard.run(`op${i}`, probe, '-1001234567890');
    }
    expect(probe).not.toHaveBeenCalled();

    // Одна строка на ожидание, с дедлайном; полного стека и тел постов нет.
    const lines = warnSpy.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('FLOOD_WAIT 50000s');
    expect(lines[0]).toContain(new Date(NOW + 50_000_000).toISOString());
    expect(lines[0]).not.toContain('\n');

    jest.advanceTimersByTime(50_000_001);
    await guard.run('after', probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('FloodWaitError с полем seconds (gramjs) тоже распознаётся', async () => {
    // Текст без «A wait of N seconds»: ждём срабатывания именно поля seconds.
    const error = Object.assign(new Error('RPCError 420: FLOOD'), { seconds: 42 });
    await guard.run('op', jest.fn().mockRejectedValue(error));
    expect(guard.blockedUntil()).toBe(NOW + 42_000);
  });

  it('параллельные вызовы с одинаковым ожиданием дают одну строку лога', async () => {
    const first = guard.run('getHistory', jest.fn().mockRejectedValue(floodError(100)));
    const second = guard.run('getMessages:eval', jest.fn().mockRejectedValue(floodError(100)));
    await Promise.all([first, second]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('FLOOD_WAIT 100s');
  });

  it('то же ожидание, отчётом позже, не продлевает паузу и не логируется второй раз', async () => {
    let rejectLate: (error: unknown) => void = () => undefined;
    const inFlight = new Promise((_resolve, reject) => {
      rejectLate = reject as never;
    });
    // Вызов начался до паузы (так и приходит второй отчёт об уже известном ожидании).
    const late = guard.run('getMessages:eval', () => inFlight as never);

    await guard.run('getHistory', jest.fn().mockRejectedValue(floodWaitText(100)));
    const deadline = guard.blockedUntil();
    expect(deadline).toBe(NOW + 100_000);

    jest.advanceTimersByTime(30_000);
    rejectLate(floodWaitText(100));
    await late;

    expect(guard.blockedUntil()).toBe(deadline);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('более длинное ожидание продлевает паузу и логируется', async () => {
    let rejectLate: (error: unknown) => void = () => undefined;
    const inFlight = new Promise((_resolve, reject) => {
      rejectLate = reject as never;
    });
    const late = guard.run('getMessages:eval', () => inFlight as never);

    await guard.run('getHistory', jest.fn().mockRejectedValue(floodWaitText(100)));
    jest.advanceTimersByTime(10_000);
    rejectLate(floodWaitText(5_000));
    await late;

    expect(guard.blockedUntil()).toBe(NOW + 10_000 + 5_000_000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1][0])).toContain('FLOOD_WAIT 5000s');
  });

  it('обычная ошибка → undefined, без ретрая и без паузы', async () => {
    let attempts = 0;
    const result = await guard.run('op', async () => {
      attempts += 1;
      throw new Error('boom');
    });
    expect(result).toBeUndefined();
    expect(attempts).toBe(1);
    expect(guard.isBlocked()).toBe(false);
  });

  it('терминальная ошибка → алерт владельцу + исключение', async () => {
    const terminal = new Error('USER_DEACTIVATED_BAN');
    (terminal as { errorMessage?: string }).errorMessage = 'USER_DEACTIVATED_BAN';

    const promise = guard.run('op', async () => {
      throw terminal;
    });

    const expectation = expect(promise).rejects.toThrow(TerminalMtprotoError);
    await flush();
    await expectation;
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringContaining('USER_DEACTIVATED_BAN')
    );
  });

  it('алерт отправляется один раз', async () => {
    const terminal = new Error('AUTH_KEY_UNREGISTERED');
    (terminal as { errorMessage?: string }).errorMessage = 'AUTH_KEY_UNREGISTERED';

    const first = guard.run('op', async () => {
      throw terminal;
    }).catch(() => undefined);
    await flush();
    const second = guard.run('op2', async () => {
      throw terminal;
    }).catch(() => undefined);
    await flush();
    await Promise.all([first, second]);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  describe('промах сущности (CHANNEL_INVALID → input entity)', () => {
    const chatId = '-1007770000001';

    it('регресс TGB-118: первый промах НЕ удаляет строки сессии, кэш в памяти сброшен', async () => {
      const parserClient = makeEntityClient(chatId);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);
      const client = parserClient.client();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(channelInvalid())
        .mockResolvedValueOnce('resolved');

      await expect(guard.run('getMessages:eval', fn, chatId)).resolves.toBe('resolved');
      expect(fn).toHaveBeenCalledTimes(2);
      // In-memory кэш пира сброшен — следующий вызов резолвит заново.
      expect(client._entityCache.cacheMap.size).toBe(0);
      // Строки `session._entities` НЕ удаляются: их вычистка и была регрессией
      // (пир переставал резолвиться до рестарта).
      expect(client.session._entities.size).toBe(1);
      // Стор перезаполнен документированным путём.
      expect(parserClient.getDialogs).toHaveBeenCalledWith({ limit: 200 });
      expect(parserClient.getDialogs).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('refresh стора: один getDialogs на окно, второй промах внутри окна его не повторяет', async () => {
      const parserClient = makeEntityClient(chatId);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      const first = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', first, chatId)).resolves.toBe('ok');
      expect(parserClient.getDialogs).toHaveBeenCalledTimes(1);

      // Другой пир промахнулся сразу же: refresh-окно ещё не истекло.
      const other = '-1007770000099';
      const second = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', second, other)).resolves.toBe('ok');
      expect(parserClient.getDialogs).toHaveBeenCalledTimes(1);

      // Окно (5 минут) истекло — следующий промах снова обновляет стор.
      jest.advanceTimersByTime(ENTITY_REFRESH_COOLDOWN_MS + 1);
      const third = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', third, other)).resolves.toBe('ok');
      expect(parserClient.getDialogs).toHaveBeenCalledTimes(2);
    });

    it('параллельные промахи разных пиров ждут один и тот же refresh (single flight)', async () => {
      const parserClient = makeEntityClient(chatId);
      let release: (value: unknown) => void = () => undefined;
      parserClient.getDialogs.mockImplementation(
        () => new Promise((resolve) => (release = resolve))
      );
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      const first = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('a');
      const second = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('b');
      const a = guard.run('getHistory', first, chatId);
      const b = guard.run('getHistory', second, '-1007770000199');
      await flush();
      expect(parserClient.getDialogs).toHaveBeenCalledTimes(1);

      release([]);
      await expect(a).resolves.toBe('a');
      await expect(b).resolves.toBe('b');
      expect(parserClient.getDialogs).toHaveBeenCalledTimes(1);
    });

    it('упавший refresh не паркует пир на час: только до следующего окна', async () => {
      const parserClient = makeEntityClient(chatId);
      parserClient.getDialogs.mockRejectedValue(new Error('dialogs down'));
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      const fn = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getHistory', fn, chatId);

      expect(fn).toHaveBeenCalledTimes(2); // вызов + один повтор после refresh
      // Один транзиентный сбой getDialogs не выключает источник на час:
      // пауза — только до следующего окна refresh-а.
      expect(guard.isPeerBroken(chatId)).toBe(true);
      jest.advanceTimersByTime(ENTITY_REFRESH_COOLDOWN_MS + 1);
      expect(guard.isPeerBroken(chatId)).toBe(false);
      const probe = jest.fn().mockResolvedValue('ok');
      await expect(guard.run('getHistory', probe, chatId)).resolves.toBe('ok');
      expect(probe).toHaveBeenCalledTimes(1);

      const lines = warnSpy.mock.calls.map(([line]) => String(line));
      expect(lines[0]).toContain('перезаполнение стора сущностей не удалось');
      expect(String(lines[1])).toContain('refresh не удался');
      expect(String(lines[1])).toContain('свип-пауза');
      expect(String(lines[1])).not.toContain(`свип-пауза ${ENTITY_BROKEN_RETRY_MS}ms`);
      for (const line of lines) expect(String(line)).not.toContain('\n');
    });

    it('пропущенный refresh тоже не паркует на час: пауза до окна', async () => {
      const parserClient = makeEntityClient(chatId);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      // Первый промах занимает refresh-окно…
      const warm = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', warm, chatId)).resolves.toBe('ok');

      // …второй пир промахивается внутри окна: refresh пропущен.
      const other = '-1007770000077';
      const miss = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getHistory', miss, other);

      const line = String(warnSpy.mock.calls[0][0]);
      expect(line).toContain('refresh пропущен');
      expect(line).not.toContain(`свип-пауза ${ENTITY_BROKEN_RETRY_MS}ms`);
      // Через окно пир снова доступен и оживает без часового простоя.
      jest.advanceTimersByTime(ENTITY_REFRESH_COOLDOWN_MS + 1);
      expect(guard.isPeerBroken(other)).toBe(false);
      const probe = jest.fn().mockResolvedValue('ok');
      await expect(guard.run('getHistory', probe, other)).resolves.toBe('ok');
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('FLOOD_WAIT от getDialogs закрывает гейт: повтор после промаха не идёт', async () => {
      const parserClient = makeEntityClient(chatId);
      parserClient.getDialogs.mockRejectedValue(floodWaitText(77));
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      const fn = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getHistory', fn, chatId);

      expect(fn).toHaveBeenCalledTimes(1); // второго вызова нет: MTProto на паузе
      expect(guard.blockedUntil()).toBe(NOW + 77_000);
      const lines = warnSpy.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('FLOOD_WAIT 77s');
    });

    it('пауза, включённая параллельным вызовом, отменяет refresh и повтор', async () => {
      const parserClient = makeEntityClient(chatId);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      const fn = jest.fn(async () => {
        // Другой MTProto-вызов поймал FLOOD_WAIT, пока этот шёл.
        mtprotoFloodGate.block(30, 0);
        throw channelInvalid();
      });

      await expect(guard.run('getHistory', fn, chatId)).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1); // повтора нет: гейт закрыт
      expect(parserClient.getDialogs).not.toHaveBeenCalled();
      expect(guard.isBlocked()).toBe(true);
    });

    it('свежий access hash выигрывает у устаревшего: дубли строк пира схлопываются', async () => {
      const stale = [chatId, 'stale-hash', 'chan', null, 'Chan'];
      const mid = [chatId, 'mid-hash', 'chan', null, 'Chan'];
      const foreign = ['-100999', 'other-hash', 'other', null, 'Other'];
      const fresh = [chatId, 'fresh-hash', 'chan', null, 'Chan'];
      const rows = new Set<unknown[]>([stale, foreign, mid]);
      const cacheMap = new Map<string, unknown>();
      const getDialogs = jest.fn(async () => {
        // gramjs добавляет строку из ответа `chats`, не заменяя старые.
        rows.add(fresh);
        cacheMap.set(chatId, { className: 'InputPeerChannel' });
        return [];
      });
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => ({ _entityCache: { cacheMap }, session: { _entities: rows }, getDialogs }),
      } as never);

      const fn = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', fn, chatId)).resolves.toBe('ok');

      const remaining = Array.from(rows);
      expect(remaining.map((row) => row[1])).toEqual(['other-hash', 'fresh-hash']);
      // gramjs берёт первую строку пира — она должна быть свежей.
      expect(remaining.find((row) => row[0] === chatId)?.[1]).toBe('fresh-hash');
    });

    it('refresh без строк сессии не падает (свежий hash брать неоткуда)', async () => {
      const getDialogs = jest.fn().mockResolvedValue([]);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => ({ getDialogs }),
      } as never);

      const fn = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', fn, chatId)).resolves.toBe('ok');
      expect(getDialogs).toHaveBeenCalledTimes(1);
    });

    it('пира нет в диалогах — чужие строки сессии не трогаем', async () => {
      const rows = new Set<unknown[]>([
        ['-100999', 'a', 'aaa', null, 'A'],
        ['-100998', 'b', 'bbb', null, 'B'],
      ]);
      const getDialogs = jest.fn().mockResolvedValue([]);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => ({ session: { _entities: rows }, getDialogs }),
      } as never);

      const fn = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', fn, chatId)).resolves.toBe('ok');
      expect(rows.size).toBe(2);
    });

    it('одна мёртвая сущность — один ключ: raw id и marked id не расходятся', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));

      const raw = '7770000001';
      const history = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getHistory', history, raw);

      // Тот же канал в marked-форме другой операцией: ключ тот же, вызова нет.
      const evaluate = jest.fn().mockResolvedValue('ok');
      await guard.run('getMessages:eval', evaluate, chatId);
      expect(evaluate).not.toHaveBeenCalled();
      expect(guard.isPeerBroken(chatId)).toBe(true);
      expect(guard.isPeerBroken(raw)).toBe(true);
    });

    it('состояние по пирам ограничено: username-флуд не растит карты без границы', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom());

      const fn = jest.fn().mockRejectedValue(channelInvalid());
      for (let id = 0; id < 5001; id += 1) {
        await guard.run('getHistory', fn, `-10090000${String(id).padStart(5, '0')}`);
      }

      const state = (guard as never as { entityBackoff: Map<string, unknown> }).entityBackoff;
      expect(state.size).toBe(5000);
    });

    it('повторные промахи: бэкофф 1s→2s→4s, перерезолв на каждой попытке, одна строка на шаг', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));

      const first = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getMessages:eval', first, chatId);
      expect(first).toHaveBeenCalledTimes(2); // первичный вызов + один перерезолв

      const probe = jest.fn().mockRejectedValue(channelInvalid());
      // Шаг 1 подождан: 1000 мс.
      await guard.run('getMessages:eval', probe, chatId);
      expect(probe).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);
      await guard.run('getMessages:eval', probe, chatId);
      expect(probe).toHaveBeenCalledTimes(2); // вызов + перерезолв (кэш мог протухнуть снова)

      // Шаг 2: 2000 мс — до дедлайна молчим.
      jest.advanceTimersByTime(1_000);
      await guard.run('getMessages:eval', probe, chatId);
      expect(probe).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1_001);
      await guard.run('getMessages:eval', probe, chatId);
      expect(probe).toHaveBeenCalledTimes(4);

      const lines = warnSpy.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(3); // 1s, 2s, 4s — по строке на шаг
      expect(lines.map((line) => line.match(/бэкофф (\d+)ms/)?.[1])).toEqual(['1000', '2000', '4000']);
      for (const line of lines) expect(line).not.toContain('\n');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('бэкофф ограничен капом 15 минут', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));
      expect(entityBackoffMs(1)).toBe(1_000);
      expect(entityBackoffMs(5)).toBe(16_000);
      expect(entityBackoffMs(20)).toBe(ENTITY_BACKOFF_CAP_MS);

      const fn = jest.fn().mockRejectedValue(inputEntityMiss());
      await guard.run('getHistory', fn, chatId); // 2 вызова: промах + перерезолв
      for (let step = 0; step < 12; step += 1) {
        jest.advanceTimersByTime(ENTITY_BACKOFF_CAP_MS + 1);
        await guard.run('getHistory', fn, chatId);
      }
      const delays = warnSpy.mock.calls.map(([line]) =>
        Number(String(line).match(/бэкофф (\d+)ms/)?.[1])
      );
      expect(delays[delays.length - 1]).toBe(ENTITY_BACKOFF_CAP_MS);
      expect(Math.max(...delays)).toBe(ENTITY_BACKOFF_CAP_MS);
      expect(delays.every((delay) => delay <= ENTITY_BACKOFF_CAP_MS)).toBe(true);
      // Полного стека на попытку нет: ни одной строки с трейсом.
      expect(warnSpy.mock.calls.map(([line]) => String(line)).join(' ')).not.toContain('    at ');
    });

    it('успех снимает бэкофф: следующая операция идёт сразу', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));

      await guard.run('getMessages:eval', jest.fn().mockRejectedValue(channelInvalid()), chatId);
      jest.advanceTimersByTime(1_001);

      const ok = jest.fn().mockResolvedValue('ok');
      await expect(guard.run('getMessages:eval', ok, chatId)).resolves.toBe('ok');

      // Очередь разблокирована: та же операция без ожидания.
      await expect(guard.run('getMessages:eval', ok, chatId)).resolves.toBe('ok');
      expect(ok).toHaveBeenCalledTimes(2);
    });

    it('скоупы бэкоффа независимы: мёртвый username не блокирует другие', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));

      const dead = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getEntity', dead, 'DeadChannel');
      expect(dead).toHaveBeenCalledTimes(2); // промах + перерезолв

      // Другой username идёт сразу: у него свой скоуп.
      const alive = jest.fn().mockResolvedValue('entity');
      await expect(guard.run('getEntity', alive, 'AliveChannel')).resolves.toBe('entity');
      expect(alive).toHaveBeenCalledTimes(1);

      // А мёртвый — по-прежнему в бэкоффе.
      const deadAgain = jest.fn().mockResolvedValue('entity');
      await guard.run('getEntity', deadAgain, 'DeadChannel');
      expect(deadAgain).not.toHaveBeenCalled();

      // В логе оба ника замаскированы одинаково, скоупы не различить по логу.
      const lines = warnSpy.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('<username>');
    });

    it('без ключа пира перерезолв не делается: сразу бэкофф по операции', async () => {
      const fn = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getDialogs', fn);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('бэкофф 1000ms');
    });

    it('промах без клиента/кэшей: перерезолв один, падений нет', async () => {
      // Порт клиента не внедрён (юнит-режим): перерезолв всё равно один.
      const fn = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getMessages:eval', fn, '-1007770000002')).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);

      // Клиент есть, кэшей сущностей нет.
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => ({}),
      } as never);
      const fn2 = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', fn2, '-1007770000003')).resolves.toBe('ok');

      // Наблюдатель выключен: client() → undefined.
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => undefined,
      } as never);
      const fn3 = jest.fn().mockRejectedValueOnce(inputEntityMiss()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', fn3, '-1007770000004')).resolves.toBe('ok');
    });

    it('промах сущности: чужие записи кэша не трогаем, строки сессии не удаляем', async () => {
      const cacheMap = new Map<string, unknown>([['-100999', { peer: 1 }]]);
      const rows = new Set<unknown[]>([['-100999', 'hash', 'other', null, 'Other']]);
      const parserClient: any = {
        client: () => ({ _entityCache: { cacheMap }, session: { _entities: rows } }),
      };
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), parserClient);

      const miss = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getEntity', miss, 'SomeChannel')).resolves.toBe('ok');
      expect(cacheMap.size).toBe(1);
      // Строки сессии живут только в персистентном сторе: не удаляем даже свои.
      expect(rows.size).toBe(1);

      // Кэша в памяти нет вообще — падений нет, строки сессии тоже целы.
      const rows2 = new Set<unknown[]>([['-100998', 'hash', 'somechannel', null, 'Some']]);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => ({ session: { _entities: rows2 } }),
      } as never);
      const miss2 = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getEntity', miss2, 'SomeChannel')).resolves.toBe('ok');
      expect(rows2.size).toBe(1);
    });

    it('в строке бэкоффа нет username — только маска', async () => {
      const fn = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getEntity', fn, 'SomePublicChannel');

      const line = String(warnSpy.mock.calls[0][0]);
      expect(line).toContain('<username>');
      expect(line).not.toContain('SomePublicChannel');
    });

    it('сырой id пира тоже снимает marked-запись кэша', async () => {
      const cacheMap = new Map<string, unknown>([['-1007770000005', { peer: 1 }]]);
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), {
        client: () => ({ _entityCache: { cacheMap } }),
      } as never);

      const miss = jest.fn().mockRejectedValueOnce(channelInvalid()).mockResolvedValueOnce('ok');
      await expect(guard.run('getHistory', miss, '7770000005')).resolves.toBe('ok');
      expect(cacheMap.size).toBe(0);
    });

    it('мёртвый пир: на свип-паузе пропускается (свип не дёргает MTProto), соседние пиры работают', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));

      const dead = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getHistory', dead, chatId);
      expect(dead).toHaveBeenCalledTimes(2); // вызов + один повтор после refresh
      expect(guard.isPeerBroken(chatId)).toBe(true);

      // Свип через 30 минут спрашивает isPeerBroken и пир не трогает
      // (проверка самого свипа — в parser-collector.service.spec.ts).
      jest.advanceTimersByTime(30 * 60 * 1000);
      expect(guard.isPeerBroken(chatId)).toBe(true);

      // Остальные источники свипа не задеты.
      const healthy = jest.fn().mockResolvedValue('ok');
      await expect(guard.run('getHistory', healthy, '-1007770000088')).resolves.toBe('ok');
      expect(healthy).toHaveBeenCalledTimes(1);

      // Горизонт истёк — один пробный вызов, успех снимает паузу.
      jest.advanceTimersByTime(ENTITY_BROKEN_RETRY_MS);
      expect(guard.isPeerBroken(chatId)).toBe(false);
      const probe = jest.fn().mockResolvedValue('ok');
      await expect(guard.run('getHistory', probe, chatId)).resolves.toBe('ok');
      expect(probe).toHaveBeenCalledTimes(1);
      expect(guard.isPeerBroken(chatId)).toBe(false);

      // Одна строка на шаг бэкоффа, не на попытку.
      const lines = warnSpy.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('бэкофф 1000ms');
    });

    it('промах пира блокирует все операции по нему (одна мёртвая сущность — один бэкофф)', async () => {
      guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom(), makeEntityClient(chatId));

      const history = jest.fn().mockRejectedValue(channelInvalid());
      await guard.run('getHistory', history, chatId);

      // Оценщик идёт по тому же источнику другой операцией: бэкофф общий по пиру.
      const evaluate = jest.fn().mockResolvedValue('ok');
      await guard.run('getMessages:eval', evaluate, chatId);
      expect(evaluate).not.toHaveBeenCalled();

      // Курсор бэкоффа истёк — операция снова разрешена (пир оживает сам).
      jest.advanceTimersByTime(1_001);
      await expect(guard.run('getMessages:eval', evaluate, chatId)).resolves.toBe('ok');
      expect(guard.isPeerBroken(chatId)).toBe(false);
    });
  });

  it('ошибка без текста (null/undefined) не роняет guard', async () => {
    await expect(
      guard.run('op', async () => {
        throw null;
      })
    ).resolves.toBeUndefined();
    await expect(
      guard.run('op2', async () => {
        throw undefined;
      })
    ).resolves.toBeUndefined();
    expect(guard.isBlocked()).toBe(false);
  });

  it('pace без подмены sleep реально ждёт (таймер unref)', async () => {
    const paused = guard.pace(50, 0);
    jest.advanceTimersByTime(50);
    await expect(paused).resolves.toBeUndefined();
  });

  it('pace добавляет jitter (random=0 → base)', async () => {
    const sleepSpy = jest.spyOn(guard as never as { sleep: (ms: number) => Promise<void> }, 'sleep');
    sleepSpy.mockResolvedValue(undefined);
    await guard.pace(1500);
    expect(sleepSpy).toHaveBeenCalledWith(1500);
  });
});
