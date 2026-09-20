import { ParserMtprotoGuard, TerminalMtprotoError } from './parser-mtproto-guard.service';

const makeBot = (): any => ({ api: { sendMessage: jest.fn().mockResolvedValue(undefined) } });
const makeConfig = (): any => ({ ownerId: 1 });
const makeRandom = (): any => ({ next: jest.fn().mockReturnValue(0) });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const floodError = (seconds: number): Error => {
  const error = new Error(`RPCError 420: FLOOD_WAIT_${seconds}`);
  (error as { errorMessage?: string }).errorMessage = `FLOOD_WAIT_${seconds}`;
  return error;
};

describe('ParserMtprotoGuard', () => {
  let guard: any;
  let bot: any;
  let sleepSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    bot = makeBot();
    guard = new ParserMtprotoGuard(bot, makeConfig(), makeRandom());
    sleepSpy = jest.spyOn(guard as never as { sleep: (ms: number) => Promise<void> }, 'sleep');
    sleepSpy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('успешная операция проходит без ретраев', async () => {
    const result = await guard.run('op', async () => 'ok');
    expect(result).toBe('ok');
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('FLOOD_WAIT → пауза секунд+1 и повтор', async () => {
    let attempts = 0;
    const result = await guard.run('op', async () => {
      attempts += 1;
      if (attempts === 1) throw floodError(7);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledWith(8000);
  });

  it('одиночный FLOOD_WAIT больше кумулятивного бюджета → сдаёмся сразу', async () => {
    const result = await guard.run('op', async () => {
      throw floodError(5000);
    });
    expect(result).toBeUndefined();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('пауза секунд+1 в пределах кумулятивного бюджета', async () => {
    let attempts = 0;
    const result = await guard.run('op', async () => {
      attempts += 1;
      if (attempts === 1) throw floodError(250);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(sleepSpy).toHaveBeenCalledWith(251000);
  });

  it('исчерпание бюджета → undefined без исключения', async () => {
    const result = await guard.run('op', async () => {
      throw floodError(60);
    });
    expect(result).toBeUndefined();
  });

  it('обычная ошибка → undefined, без ретрая', async () => {
    let attempts = 0;
    const result = await guard.run('op', async () => {
      attempts += 1;
      throw new Error('boom');
    });
    expect(result).toBeUndefined();
    expect(attempts).toBe(1);
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

  it('pace добавляет jitter (random=0 → base)', async () => {
    await guard.pace(1500);
    expect(sleepSpy).toHaveBeenCalledWith(1500);
  });
});
