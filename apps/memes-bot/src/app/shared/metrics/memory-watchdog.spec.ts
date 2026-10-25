import * as fs from 'fs';

import {
  MEMORY_WATCHDOG_DEFAULTS,
  MemoryWatchdog,
  MemoryWatchdogConfig,
  WATCHDOG_EXIT_RSS,
  WATCHDOG_EXIT_STALL,
  memoryWatchdogConfigFromEnv,
  resolveCgroupUsageBytes,
  resolveMemoryLimit,
  resolveMemoryLimitBytes,
  startMemoryWatchdogFromEnv,
} from './memory-watchdog';
import { metrics } from './metrics';

const MIB = 1024 * 1024;
const LIMIT_512 = 512 * MIB;

/** Every watchdog built by a test is stopped afterwards: no timer leaks. */
const running: MemoryWatchdog[] = [];

afterEach(() => {
  for (const watchdog of running) {
    watchdog.stop();
  }
  running.length = 0;
});

function config(overrides: Partial<MemoryWatchdogConfig> = {}): MemoryWatchdogConfig {
  return {
    enabled: true,
    heartbeatMs: 10_000,
    stallMs: 90_000,
    sampleMs: 60_000,
    highRssMs: 300_000,
    rssThreshold: 0.85,
    snapshotMs: 900_000,
    warmupMs: 0,
    publishGraceMs: 120_000,
    ...overrides,
  };
}

interface Harness {
  watchdog: MemoryWatchdog;
  exit: jest.Mock;
  lines: string[];
  events: string[];
  setNow: (value: number) => void;
  setPublish: (inFlight: boolean, line?: string) => void;
}

function harness(
  overrides: Partial<MemoryWatchdogConfig> = {},
  options: {
    limitBytes?: number;
    cgroupBytes?: number | null;
    publishInFlight?: boolean;
    publishLine?: string;
    memoryUsage?: () => NodeJS.MemoryUsage;
  } = {}
): Harness {
  let now = 0;
  let inFlight = options.publishInFlight ?? false;
  let publishLine = options.publishLine ?? 'idle';
  const exit = jest.fn();
  const lines: string[] = [];
  const events: string[] = [];
  const usage = {
    rss: 100 * MIB,
    heapUsed: 20 * MIB,
    external: 5 * MIB,
    arrayBuffers: 3 * MIB,
  };
  const limit = options.limitBytes ?? LIMIT_512;
  const cgroup = options.cgroupBytes ?? null;
  const watchdog = new MemoryWatchdog({
    config: config(overrides),
    monotonic: () => now,
    exit: (code) => {
      events.push(`exit:${code}`);
      exit(code);
    },
    write: (line) => {
      events.push(`write:${line.trimEnd()}`);
      lines.push(line);
    },
    readFile: (path) => {
      if (path === '/sys/fs/cgroup/memory.max') return String(limit);
      if (path === '/sys/fs/cgroup/memory.current') {
        return cgroup === null ? null : String(cgroup);
      }
      return null;
    },
    memoryUsage: options.memoryUsage ?? (() => usage as NodeJS.MemoryUsage),
    publish: {
      inFlight: () => inFlight,
      describe: () => publishLine,
    },
    env: {},
  });
  running.push(watchdog);
  return {
    watchdog,
    exit,
    lines,
    events,
    setNow: (value) => {
      now = value;
    },
    setPublish: (value, line) => {
      inFlight = value;
      publishLine = line ?? publishLine;
    },
  };
}

const overLimit = (): NodeJS.MemoryUsage =>
  ({ rss: 500 * MIB, heapUsed: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage);

describe('memoryWatchdogConfigFromEnv', () => {
  it('по умолчанию включён вне тестов и выключен в NODE_ENV=test', () => {
    expect(memoryWatchdogConfigFromEnv({}).enabled).toBe(true);
    expect(memoryWatchdogConfigFromEnv({ NODE_ENV: 'production' }).enabled).toBe(true);
    expect(memoryWatchdogConfigFromEnv({ NODE_ENV: 'test' }).enabled).toBe(false);
    expect(
      memoryWatchdogConfigFromEnv({ NODE_ENV: 'test', WATCHDOG_ENABLED: 'true' }).enabled
    ).toBe(true);
    expect(
      memoryWatchdogConfigFromEnv({ NODE_ENV: 'production', WATCHDOG_ENABLED: 'false' }).enabled
    ).toBe(false);
  });

  it('дефолты совпадают с контрактом TGB-121', () => {
    expect(memoryWatchdogConfigFromEnv({})).toMatchObject({
      heartbeatMs: 10_000,
      stallMs: 90_000,
      sampleMs: 60_000,
      highRssMs: 300_000,
      rssThreshold: 0.85,
      snapshotMs: 900_000,
      warmupMs: 600_000,
      publishGraceMs: 120_000,
    });
    expect(MEMORY_WATCHDOG_DEFAULTS.stallMs).toBe(90_000);
    expect(MEMORY_WATCHDOG_DEFAULTS.publishGraceMs).toBe(120_000);
  });

  it('читает переопределения и игнорирует мусор', () => {
    const parsed = memoryWatchdogConfigFromEnv({
      WATCHDOG_HEARTBEAT_MS: '5000',
      WATCHDOG_STALL_MS: 'nope',
      WATCHDOG_SAMPLE_MS: '-1',
      WATCHDOG_HIGH_RSS_MS: '120000',
      WATCHDOG_RSS_THRESHOLD: '0.5',
      WATCHDOG_SNAPSHOT_MS: '60000',
      WATCHDOG_PUBLISH_GRACE_MS: '30000',
      WATCHDOG_WARMUP_MS: '0',
    });
    expect(parsed.heartbeatMs).toBe(5000);
    expect(parsed.stallMs).toBe(90_000);
    expect(parsed.sampleMs).toBe(60_000);
    expect(parsed.highRssMs).toBe(120_000);
    expect(parsed.rssThreshold).toBe(0.5);
    expect(parsed.snapshotMs).toBe(60_000);
    expect(parsed.publishGraceMs).toBe(30_000);
    // `WATCHDOG_WARMUP_MS=0` не проходит как positive number — остаётся дефолт.
    expect(parsed.warmupMs).toBe(600_000);
    expect(memoryWatchdogConfigFromEnv({ WATCHDOG_RSS_THRESHOLD: '2' }).rssThreshold).toBe(0.85);
  });
});

describe('resolveMemoryLimit', () => {
  const read = (files: Record<string, string | null>) => (path: string) => files[path] ?? null;

  it('берёт cgroup v2 memory.max и помечает источник', () => {
    expect(resolveMemoryLimit(read({ '/sys/fs/cgroup/memory.max': '536870912' }), {})).toEqual({
      bytes: LIMIT_512,
      source: 'cgroup2',
    });
  });

  it('при v2 `max` падает на v1', () => {
    expect(
      resolveMemoryLimit(
        read({
          '/sys/fs/cgroup/memory.max': 'max',
          '/sys/fs/cgroup/memory/memory.limit_in_bytes': '268435456',
        }),
        {}
      )
    ).toEqual({ bytes: 256 * MIB, source: 'v1' });
  });

  it('игнорирует v1-сентинел «без лимита» и берёт MEM_LIMIT_MB', () => {
    expect(
      resolveMemoryLimit(
        read({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }),
        { MEM_LIMIT_MB: '256' }
      )
    ).toEqual({ bytes: 256 * MIB, source: 'env' });
  });

  it('без cgroup и env — дефолт 512 MiB с явным источником', () => {
    expect(resolveMemoryLimit(read({}), {})).toEqual({ bytes: LIMIT_512, source: 'default' });
    expect(resolveMemoryLimit(read({}), { MEM_LIMIT_MB: 'abc' })).toEqual({
      bytes: LIMIT_512,
      source: 'default',
    });
  });

  it('resolveMemoryLimitBytes остаётся bytes-only обёрткой', () => {
    expect(resolveMemoryLimitBytes(read({ '/sys/fs/cgroup/memory.max': '1048576' }), {})).toBe(MIB);
  });

  it('resolveCgroupUsageBytes читает v2/v1 и возвращает null без файлов', () => {
    expect(resolveCgroupUsageBytes(read({ '/sys/fs/cgroup/memory.current': '104857600' }))).toBe(
      100 * MIB
    );
    expect(
      resolveCgroupUsageBytes(read({ '/sys/fs/cgroup/memory/memory.usage_in_bytes': '209715200' }))
    ).toBe(200 * MIB);
    expect(resolveCgroupUsageBytes(read({}))).toBeNull();
  });
});

describe('MemoryWatchdog: запуск', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('disabled — не пишет и не ставит таймеры', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const h = harness({ enabled: false });
    h.watchdog.start();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(h.lines).toEqual([]);
  });

  it('включает три таймера и пишет строку старта с cap и источником лимита', () => {
    jest.useFakeTimers();
    const h = harness();
    const heartbeat = jest.spyOn(h.watchdog, 'onHeartbeat');
    const sample = jest.spyOn(h.watchdog, 'onSample');
    const snapshot = jest.spyOn(h.watchdog, 'onSnapshot');

    h.watchdog.start();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0].trim()).toMatch(
      /^mem watchdog started heartbeat_ms=10000 stall_ms=90000 .* cap=512 limit_source=cgroup2$/
    );
    expect(h.lines[0]).toContain('publish_grace_ms=120000');

    jest.advanceTimersByTime(10_000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(50_000);
    expect(sample).toHaveBeenCalled();
    jest.advanceTimersByTime(840_000);
    expect(snapshot).toHaveBeenCalled();
  });

  it('startMemoryWatchdogFromEnv — no-op в test-окружении, старт с инъекцией', () => {
    expect(startMemoryWatchdogFromEnv({ NODE_ENV: 'test' })).toBeUndefined();

    const write = jest.fn();
    const exit = jest.fn();
    const watchdog = startMemoryWatchdogFromEnv(
      { NODE_ENV: 'test', WATCHDOG_ENABLED: 'true' },
      { write, exit, readFile: () => null, memoryUsage: overLimit }
    );
    if (watchdog) {
      running.push(watchdog);
    }
    expect(watchdog).toBeInstanceOf(MemoryWatchdog);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('mem watchdog started'));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('MemoryWatchdog: stall detection', () => {
  it('не завершается при разрыве 60 с и завершает с кодом 3 после 91 с', () => {
    const h = harness();
    h.watchdog.start();

    h.setNow(60_000);
    h.watchdog.onHeartbeat();
    expect(h.exit).not.toHaveBeenCalled();

    h.setNow(60_000 + 91_000);
    h.watchdog.onHeartbeat();

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_STALL);
    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'));
    expect(exitLine).toContain('reason=stall');
    expect(exitLine).toContain('last_tick_late_ms=91000');
  });

  it('граница ровно 90 000 мс срабатывает, 89 999 — нет', () => {
    const noExit = harness();
    noExit.watchdog.start();
    noExit.setNow(89_999);
    noExit.watchdog.onHeartbeat();
    expect(noExit.exit).not.toHaveBeenCalled();

    const fires = harness();
    fires.watchdog.start();
    fires.setNow(90_000);
    fires.watchdog.onHeartbeat();
    expect(fires.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_STALL);
  });

  it('завершает максимум один раз', () => {
    const h = harness();
    h.watchdog.start();
    h.setNow(300_000);
    h.watchdog.onHeartbeat();
    h.setNow(600_000);
    h.watchdog.onHeartbeat();
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryWatchdog: метрика само-рестарта', () => {
  it('inc({reason}) вызывается ровно один раз с ограниченной причиной до exit', () => {
    const h = harness();
    const inc = jest.spyOn(metrics.watchdog.exits, 'inc').mockImplementation((() => {
      h.events.push('inc');
    }) as never);
    h.watchdog.start();

    h.setNow(90_000);
    h.watchdog.onHeartbeat();
    h.setNow(200_000);
    h.watchdog.onHeartbeat();

    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ reason: 'stall' });
    const incIndex = h.events.indexOf('inc');
    const exitIndex = h.events.findIndex((event) => event.startsWith('exit:'));
    expect(incIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(incIndex);
    inc.mockRestore();
  });

  it('причина rss тоже ограничена значением из двух', () => {
    const inc = jest.spyOn(metrics.watchdog.exits, 'inc');
    const h = harness({}, { memoryUsage: overLimit });
    h.watchdog.start();
    for (let minute = 0; minute <= 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ reason: 'rss' });
    inc.mockRestore();
  });
});

describe('MemoryWatchdog: порог 85%', () => {
  it('5 подряд минут выше порога → exit(4)', () => {
    const h = harness({}, { memoryUsage: overLimit });
    h.watchdog.start();

    for (let minute = 0; minute < 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(h.exit).not.toHaveBeenCalled();

    h.setNow(300_000);
    h.watchdog.onSample();
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);

    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'));
    expect(exitLine).toContain('reason=rss');
    expect(exitLine).toContain('over_limit_ms=300000');
    expect(exitLine).toContain('recent_rss=500,500,500,500,500');
    expect(exitLine).toContain('limit_source=cgroup2');
  });

  it('4 минуты выше порога — без exit', () => {
    const h = harness({}, { memoryUsage: overLimit });
    h.watchdog.start();
    for (let minute = 0; minute < 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('снижение ниже порога сбрасывает окно и отложенный exit', () => {
    let rss = 500 * MIB;
    const h = harness(
      {},
      {
        memoryUsage: () =>
          ({ rss, heapUsed: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage),
      }
    );
    h.watchdog.start();

    h.watchdog.onSample(); // t=0, окно началось
    h.setNow(60_000);
    h.watchdog.onSample();
    rss = 100 * MIB;
    h.setNow(120_000);
    h.watchdog.onSample(); // окно сброшено
    expect(h.exit).not.toHaveBeenCalled();

    rss = 500 * MIB;
    h.setNow(180_000);
    h.watchdog.onSample(); // окно началось заново
    h.setNow(420_000);
    h.watchdog.onSample(); // 240 с — мало
    expect(h.exit).not.toHaveBeenCalled();

    h.setNow(480_000);
    h.watchdog.onSample(); // 300 с — срабатывает
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);
  });

  it('порог считает max(RSS, cgroup memory.current)', () => {
    const h = harness(
      {},
      {
        cgroupBytes: 500 * MIB,
        memoryUsage: () =>
          ({ rss: 100 * MIB, heapUsed: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage),
      }
    );
    h.watchdog.start();
    for (let minute = 0; minute <= 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);
    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'));
    expect(exitLine).toContain('rss=100');
    expect(exitLine).toContain('cgroup=500');
  });

  it('записывает гейджи rss и лимита', () => {
    const rssSpy = jest.spyOn(metrics.watchdog.rssBytes, 'set');
    const limitSpy = jest.spyOn(metrics.watchdog.limitBytes, 'set');
    const h = harness({}, { memoryUsage: overLimit });
    h.watchdog.start();
    h.watchdog.onSample();
    expect(rssSpy).toHaveBeenCalledWith(500 * MIB);
    expect(limitSpy).toHaveBeenCalledWith(LIMIT_512);
    rssSpy.mockRestore();
    limitSpy.mockRestore();
  });
});

describe('MemoryWatchdog: grace для публикации в полёте', () => {
  it('в полёте: exit отложен, после grace всё равно выходит с card', () => {
    const h = harness(
      {},
      {
        publishInFlight: true,
        publishLine: 'in_flight_for_ms=120000 card=12345',
        memoryUsage: overLimit,
      }
    );
    h.watchdog.start();
    for (let minute = 0; minute <= 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(h.exit).not.toHaveBeenCalled(); // t=5 мин: grace только начался

    h.setNow(360_000); // +60 с
    h.watchdog.onSample();
    expect(h.exit).not.toHaveBeenCalled();

    h.setNow(420_000); // +120 с = grace исчерпан
    h.watchdog.onSample();
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);
    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'));
    expect(exitLine).toContain('card=12345');
  });

  it('публикация завершилась внутри grace — exit на следующем сэмпле с publish=idle', () => {
    const h = harness({}, { publishInFlight: true, memoryUsage: overLimit });
    h.watchdog.start();
    for (let minute = 0; minute <= 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(h.exit).not.toHaveBeenCalled();

    h.setPublish(false, 'idle last_outcome=ok last_finished_ago_ms=30000');
    h.setNow(330_000);
    h.watchdog.onSample();

    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);
    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'));
    expect(exitLine).toContain('publish=idle last_outcome=ok');
  });

  it('без публикации в полёте exit не откладывается', () => {
    const h = harness({}, { memoryUsage: overLimit });
    h.watchdog.start();
    for (let minute = 0; minute <= 5; minute += 1) {
      h.setNow(minute * 60_000);
      h.watchdog.onSample();
    }
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);
  });
});

describe('MemoryWatchdog: warmup 10 минут', () => {
  it('не завершает процесс в первые 10 минут ни по stall, ни по памяти', () => {
    const h = harness({ warmupMs: 600_000 }, { memoryUsage: overLimit });
    h.watchdog.start();

    h.watchdog.onSample(); // t=0: окно началось, но warmup ещё идёт
    h.setNow(590_000);
    h.watchdog.onSample();
    h.watchdog.onHeartbeat();
    expect(h.exit).not.toHaveBeenCalled();

    // после warmup то же состояние даёт exit
    h.setNow(610_000);
    h.watchdog.onSample();
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_RSS);
  });

  it('stall после warmup срабатывает', () => {
    const h = harness({ warmupMs: 600_000 });
    h.watchdog.start();
    h.setNow(400_000);
    h.watchdog.onHeartbeat();
    expect(h.exit).not.toHaveBeenCalled();

    h.setNow(700_000);
    h.watchdog.onHeartbeat();
    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_STALL);
  });
});

describe('MemoryWatchdog: snapshot и строка выхода', () => {
  it('snapshot — одна строка с целыми MiB и источником лимита', () => {
    const h = harness(
      {},
      {
        memoryUsage: () =>
          ({
            rss: 104_857_600,
            heapUsed: 20_971_520,
            external: 5_242_880,
            arrayBuffers: 3_145_728,
          } as NodeJS.MemoryUsage),
      }
    );
    h.watchdog.start();
    h.watchdog.onSnapshot();
    const snapshot = h.lines.find((line) => line.startsWith('mem rss='))!;
    expect(snapshot).toBe(
      'mem rss=100 heap=20 external=5 arrayBuffers=3 cap=512 limit_source=cgroup2\n'
    );
    expect(snapshot).toMatch(
      /^mem rss=\d+ heap=\d+ external=\d+ arrayBuffers=\d+ cap=\d+ limit_source=[a-z0-9]+\n$/
    );
  });

  it('строка выхода содержит причину, память, publish-строку и пишется до exit', () => {
    const h = harness(
      {},
      { publishInFlight: true, publishLine: 'in_flight_for_ms=12345 card=777' }
    );
    h.watchdog.start();
    h.setNow(90_000);
    h.watchdog.onHeartbeat();

    const exitIndex = h.events.findIndex((event) => event === 'exit:3');
    const writeIndex = h.events.findIndex((event) => event.startsWith('write:mem watchdog exit'));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(writeIndex);

    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'))!;
    expect(exitLine).toContain('publish=in_flight_for_ms=12345 card=777');
    expect(exitLine.trim()).toMatch(
      /^mem watchdog exit reason=stall rss=\d+ heap=\d+ external=\d+ arrayBuffers=\d+ cap=\d+ limit_source=cgroup2 uptime_s=\d+ last_tick_late_ms=\d+ publish=/
    );
    // никаких id/имён: только ключи, числа и латинские литералы
    expect(exitLine.trim()).toMatch(/^[A-Za-z0-9_=,. ]+$/);
  });

  it('в строку выхода попадает cgroup usage, если он прочитан', () => {
    const lines: string[] = [];
    const exit = jest.fn();
    let now = 0;
    const watchdog = new MemoryWatchdog({
      config: config(),
      monotonic: () => now,
      exit,
      write: (line) => lines.push(line),
      readFile: (path) => {
        if (path === '/sys/fs/cgroup/memory.max') return String(LIMIT_512);
        if (path === '/sys/fs/cgroup/memory.current') return String(300 * MIB);
        return null;
      },
      memoryUsage: overLimit,
      publish: { inFlight: () => false, describe: () => 'idle' },
      env: {},
    });
    running.push(watchdog);

    watchdog.start();
    watchdog.onSample();
    now = 90_000;
    watchdog.onHeartbeat();

    expect(exit).toHaveBeenCalledWith(WATCHDOG_EXIT_STALL);
    const exitLine = lines.find((line) => line.startsWith('mem watchdog exit'))!;
    expect(exitLine).toContain('cgroup=300');
  });

  it('defaultReadFile читает файл и возвращает null при ошибке', () => {
    const limitSpy = jest.spyOn(metrics.watchdog.limitBytes, 'set');
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('1024');
    const watchdog = new MemoryWatchdog({
      config: config(),
      monotonic: () => 0,
      exit: jest.fn(),
      write: () => undefined,
      memoryUsage: () =>
        ({ rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage),
      publish: { inFlight: () => false, describe: () => 'idle' },
      env: {},
    });
    running.push(watchdog);

    watchdog.onSample();
    expect(limitSpy).toHaveBeenCalledWith(1024);

    readSpy.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    watchdog.onSample();
    expect(limitSpy).toHaveBeenLastCalledWith(LIMIT_512);

    readSpy.mockRestore();
    limitSpy.mockRestore();
  });

  it('сбой описания публикации не мешает exit: publish=unavailable', () => {
    const h = harness();
    (
      h.watchdog as unknown as { publish: { inFlight: () => boolean; describe: () => string } }
    ).publish = {
      inFlight: () => false,
      describe: () => {
        throw new Error('probe down');
      },
    };
    h.watchdog.start();
    h.setNow(90_000);
    h.watchdog.onHeartbeat();

    expect(h.exit).toHaveBeenCalledWith(WATCHDOG_EXIT_STALL);
    const exitLine = h.lines.find((line) => line.startsWith('mem watchdog exit'));
    expect(exitLine).toContain('publish=unavailable');
  });

  it('snapshot до первого сэмпла сам разрешает лимит', () => {
    const h = harness();
    h.watchdog.onSnapshot();
    const snapshot = h.lines.find((line) => line.startsWith('mem rss='))!;
    expect(snapshot).toContain('cap=512');
    expect(snapshot).toContain('limit_source=cgroup2');
  });

  it('сбой записи stdout не мешает завершению процесса', () => {
    const exit = jest.fn();
    let now = 0;
    const watchdog = new MemoryWatchdog({
      config: config(),
      monotonic: () => now,
      exit,
      write: () => {
        throw new Error('EPIPE');
      },
      readFile: () => null,
      memoryUsage: overLimit,
      publish: { inFlight: () => false, describe: () => 'idle' },
      env: {},
    });
    running.push(watchdog);

    watchdog.start();
    now = 90_000;
    watchdog.onHeartbeat();
    expect(exit).toHaveBeenCalledWith(WATCHDOG_EXIT_STALL);
  });

  it('exit-код rss — 4, stall — 3', () => {
    expect(WATCHDOG_EXIT_STALL).toBe(3);
    expect(WATCHDOG_EXIT_RSS).toBe(4);
  });
});
