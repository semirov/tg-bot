import { readFileSync, writeSync } from 'fs';
import { performance } from 'perf_hooks';

import { metrics } from './metrics';
import { describePublishActivity, isPublishInFlight } from '../publication/publish-activity';

/**
 * Self-healing memory/stall watchdog (TGB-121).
 *
 * Why `process.exit` is intentional here: the bot runs in a Docker container with
 * `mem_limit: 512m` and `restart: unless-stopped`. On 2026-10-25 the process did
 * not get OOM-killed — it starved: the event loop was blocked, `/healthz` timed
 * out (`FailingStreak 63`) and only `docker restart` helped. Docker does not
 * restart a container just because its healthcheck is failing, so the process has
 * to end itself and let the restart policy turn that into a clean cycle. The exit
 * code carries the reason (`3` = stalled event loop, `4` = sustained high memory)
 * and one structured line is written to stdout first, so the cause is never silent.
 *
 * Limits of the mechanism, documented honestly:
 * - a JS timer cannot run while the event loop is blocked *forever*; this catches
 *   starvation that eventually yields (slow progress, unresponsive HTTP, minutes
 *   long) and sustained memory pressure while the loop is still alive;
 * - GC-thrash as the exact cause of the 2026-10-25 window is a **hypothesis**, not
 *   a measurement — the evidence is RSS growth plus scrape gaps, so the exit line
 *   reports the numbers instead of claiming a mechanism;
 * - the exit line is written with a synchronous `writeSync(1, ...)` so it survives
 *   a blocked loop, but that call can block if the Docker log pipe is full; the
 *   exit still follows, only the line may be delayed or lost (the exit code and
 *   the container restart counter remain);
 * - `bot_memory_watchdog_exits_total{reason}` is **not scrapeable across the
 *   restart**: the counter is incremented in the same tick as `process.exit`, the
 *   registry dies with the process and a fresh process starts at 0. Alert on the
 *   container restart count or on the `mem watchdog exit reason=...` log line; the
 *   counter is kept only for local symmetry and for callers that never exit.
 *
 * Accepted loss: an exit during a publication can leave a burned claim with an
 * unsent post, because claims are fail-closed (TGB-117). The watchdog defers the
 * RSS exit by up to `WATCHDOG_PUBLISH_GRACE_MS` (default 120 s) while a publish is
 * in flight, and the exit line carries `publish=... card=<id>` when it has to leave
 * anyway, so the claim can be released manually:
 * `UPDATE post_scheduler_entity SET "isPublished" = false WHERE "requestChannelMessageId" = <card>;`
 */
export type WatchdogExitReason = 'stall' | 'rss';

/** Exit code for a stalled event loop (tick late by `stallMs` or more). */
export const WATCHDOG_EXIT_STALL = 3;
/** Exit code for a sustained high memory above the configured share of the limit. */
export const WATCHDOG_EXIT_RSS = 4;

const MIB = 1024 * 1024;
const DEFAULT_MEMORY_LIMIT_MB = 512;
/** Сколько последних RSS-сэмплов держать для диагностики (кольцо, не история). */
const RSS_SAMPLES_KEPT = 5;

/** Defaults of the TGB-121 contract (all overridable through env). */
export const MEMORY_WATCHDOG_DEFAULTS = {
  heartbeatMs: 10_000,
  stallMs: 90_000,
  sampleMs: 60_000,
  highRssMs: 300_000,
  rssThreshold: 0.85,
  snapshotMs: 900_000,
  warmupMs: 600_000,
  publishGraceMs: 120_000,
} as const;

/** Fully resolved watchdog configuration. */
export interface MemoryWatchdogConfig {
  /** Master switch; `false` makes the whole watchdog a no-op. */
  enabled: boolean;
  /** Heartbeat period. */
  heartbeatMs: number;
  /** A heartbeat gap of at least this many ms counts as a stalled loop. */
  stallMs: number;
  /** Memory sampling period. */
  sampleMs: number;
  /** How long memory must stay above the threshold before exiting. */
  highRssMs: number;
  /** Share of the memory limit that counts as "high" (0 < x <= 1). */
  rssThreshold: number;
  /** Period of the informational memory snapshot line. */
  snapshotMs: number;
  /** No exit happens during this window after boot. */
  warmupMs: number;
  /** How long an RSS exit waits for an in-flight publication (TGB-121). */
  publishGraceMs: number;
}

/** Probe of the current publication state used by the grace logic. */
export interface PublishProbe {
  inFlight(): boolean;
  describe(): string;
}

/** Seams used by tests; production callers keep the defaults. */
export interface MemoryWatchdogOptions {
  config: MemoryWatchdogConfig;
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  monotonic?: () => number;
  /** Process exit; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Synchronous stdout writer (survives a blocked loop); defaults to `fs.writeSync(1, ...)`. */
  write?: (line: string) => void;
  /** File reader for cgroup probes; returns `null` when the file is absent. */
  readFile?: (path: string) => string | null;
  /** Memory sampler; defaults to `process.memoryUsage`. */
  memoryUsage?: () => NodeJS.MemoryUsage;
  /** Publication probe; defaults to the publication tracker. */
  publish?: PublishProbe;
  /** Environment used for the `MEM_LIMIT_MB` fallback. */
  env?: NodeJS.ProcessEnv;
}

/** Where the container memory limit was taken from. */
export type MemoryLimitSource = 'cgroup2' | 'v1' | 'env' | 'default';

/** Resolved memory limit and its origin. */
export interface MemoryLimit {
  bytes: number;
  source: MemoryLimitSource;
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return fallback;
  }
  return `${raw}`.trim().toLowerCase() !== 'false';
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolves the watchdog configuration.
 *
 * `NODE_ENV=test` disables it by default (unit tests must not arm process exit);
 * an explicit `WATCHDOG_ENABLED=true` opts back in for the watchdog's own specs.
 */
export function memoryWatchdogConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MemoryWatchdogConfig {
  const isTest = `${env.NODE_ENV ?? ''}`.toLowerCase() === 'test';
  const threshold = positiveNumber(
    env.WATCHDOG_RSS_THRESHOLD,
    MEMORY_WATCHDOG_DEFAULTS.rssThreshold
  );
  return {
    enabled: boolFromEnv(env.WATCHDOG_ENABLED, !isTest),
    heartbeatMs: positiveNumber(env.WATCHDOG_HEARTBEAT_MS, MEMORY_WATCHDOG_DEFAULTS.heartbeatMs),
    stallMs: positiveNumber(env.WATCHDOG_STALL_MS, MEMORY_WATCHDOG_DEFAULTS.stallMs),
    sampleMs: positiveNumber(env.WATCHDOG_SAMPLE_MS, MEMORY_WATCHDOG_DEFAULTS.sampleMs),
    highRssMs: positiveNumber(env.WATCHDOG_HIGH_RSS_MS, MEMORY_WATCHDOG_DEFAULTS.highRssMs),
    rssThreshold:
      threshold > 0 && threshold <= 1 ? threshold : MEMORY_WATCHDOG_DEFAULTS.rssThreshold,
    snapshotMs: positiveNumber(env.WATCHDOG_SNAPSHOT_MS, MEMORY_WATCHDOG_DEFAULTS.snapshotMs),
    warmupMs: positiveNumber(env.WATCHDOG_WARMUP_MS, MEMORY_WATCHDOG_DEFAULTS.warmupMs),
    publishGraceMs: positiveNumber(
      env.WATCHDOG_PUBLISH_GRACE_MS,
      MEMORY_WATCHDOG_DEFAULTS.publishGraceMs
    ),
  };
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const text = raw.trim();
  // cgroup v2 reports `max` for "unlimited"; v1 uses a huge sentinel that is not
  // a safe integer, so `Number.isSafeInteger` already rejects it.
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Resolves the container memory limit and where it came from: cgroup v2, cgroup
 * v1, `MEM_LIMIT_MB`, then the 512 MiB default. The source is logged so that a
 * fallback equal to the real cap (512 MiB today) is not silently invisible.
 */
export function resolveMemoryLimit(
  readFile: (path: string) => string | null,
  env: NodeJS.ProcessEnv = process.env
): MemoryLimit {
  const v2 = parseLimit(readFile('/sys/fs/cgroup/memory.max'));
  if (v2 !== undefined) {
    return { bytes: v2, source: 'cgroup2' };
  }
  const v1 = parseLimit(readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  if (v1 !== undefined) {
    return { bytes: v1, source: 'v1' };
  }
  const envMb = Number(env.MEM_LIMIT_MB);
  if (Number.isFinite(envMb) && envMb > 0) {
    return { bytes: Math.round(envMb) * MIB, source: 'env' };
  }
  return { bytes: DEFAULT_MEMORY_LIMIT_MB * MIB, source: 'default' };
}

/** Bytes-only view of {@link resolveMemoryLimit}. */
export function resolveMemoryLimitBytes(
  readFile: (path: string) => string | null,
  env: NodeJS.ProcessEnv = process.env
): number {
  return resolveMemoryLimit(readFile, env).bytes;
}

/** Resolves current cgroup usage in bytes, or `null` when unreadable. */
export function resolveCgroupUsageBytes(readFile: (path: string) => string | null): number | null {
  const v2 = parseLimit(readFile('/sys/fs/cgroup/memory.current'));
  if (v2 !== undefined) {
    return v2;
  }
  const v1 = parseLimit(readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  return v1 ?? null;
}

function mib(bytes: number): number {
  return Math.round(bytes / MIB);
}

/**
 * Memory/stall watchdog. `start()` arms the timers; the `on*` methods are public
 * so specs can drive the state machine with an injected clock and exit function.
 */
export class MemoryWatchdog {
  private readonly config: MemoryWatchdogConfig;
  private readonly monotonic: () => number;
  private readonly exit: (code: number) => void;
  private readonly write: (line: string) => void;
  private readonly readFile: (path: string) => string | null;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly publish: PublishProbe;
  private readonly env: NodeJS.ProcessEnv;

  private timers: NodeJS.Timeout[] = [];
  private startedAt = 0;
  private lastHeartbeatAt = 0;
  private highMemorySince: number | null = null;
  /** С какого момента RSS-exit ждёт завершения публикации (grace, TGB-121). */
  private deferredSince: number | null = null;
  /** Последние RSS-сэмплы, MiB (для строки выхода); кольцо фиксированного размера. */
  private readonly recentRss: number[] = [];
  private lastLimit: MemoryLimit = { bytes: 0, source: 'default' };
  private lastCgroupBytes: number | null = null;
  private exited = false;
  private running = false;

  constructor(options: MemoryWatchdogOptions) {
    this.config = options.config;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.write = options.write ?? ((line) => writeSync(1, line));
    this.readFile = options.readFile ?? defaultReadFile;
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.publish = options.publish ?? {
      inFlight: isPublishInFlight,
      describe: describePublishActivity,
    };
    this.env = options.env ?? process.env;
  }

  /** Arms the timers. A no-op when the watchdog is disabled or already running. */
  public start(): void {
    if (!this.config.enabled || this.running) {
      return;
    }
    this.running = true;
    this.startedAt = this.monotonic();
    this.lastHeartbeatAt = this.startedAt;
    this.lastLimit = resolveMemoryLimit(this.readFile, this.env);
    for (const timer of [
      setInterval(() => this.onHeartbeat(), this.config.heartbeatMs),
      setInterval(() => this.onSample(), this.config.sampleMs),
      setInterval(() => this.onSnapshot(), this.config.snapshotMs),
    ]) {
      // `unref` keeps tests and CLI runs from being held open by the watchdog.
      timer.unref?.();
      this.timers.push(timer);
    }
    this.safeWrite(
      `mem watchdog started` +
        ` heartbeat_ms=${this.config.heartbeatMs}` +
        ` stall_ms=${this.config.stallMs}` +
        ` sample_ms=${this.config.sampleMs}` +
        ` high_rss_ms=${this.config.highRssMs}` +
        ` rss_threshold=${this.config.rssThreshold}` +
        ` snapshot_ms=${this.config.snapshotMs}` +
        ` warmup_ms=${this.config.warmupMs}` +
        ` publish_grace_ms=${this.config.publishGraceMs}` +
        ` cap=${mib(this.lastLimit.bytes)}` +
        ` limit_source=${this.lastLimit.source}\n`
    );
  }

  /** Disarms the timers (shutdown, tests). */
  public stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    this.running = false;
  }

  /** One heartbeat tick: a gap of `stallMs` or more means the loop stalled. */
  public onHeartbeat(): void {
    const now = this.monotonic();
    const lateMs = now - this.lastHeartbeatAt;
    this.lastHeartbeatAt = now;
    if (lateMs >= this.config.stallMs && !this.inWarmup(now)) {
      this.exitFor('stall', { lateMs });
    }
  }

  /**
   * One memory sample. The guard uses `max(process RSS, cgroup memory.current)`:
   * `memory.current` is what the kernel OOM-kills on, and it also counts page
   * cache that `process.memoryUsage().rss` does not.
   */
  public onSample(): void {
    const now = this.monotonic();
    const usage = this.memoryUsage();
    this.lastLimit = resolveMemoryLimit(this.readFile, this.env);
    this.lastCgroupBytes = resolveCgroupUsageBytes(this.readFile);

    metrics.watchdog.rssBytes.set(usage.rss);
    metrics.watchdog.limitBytes.set(this.lastLimit.bytes);
    this.rememberRss(usage.rss);

    const used = Math.max(usage.rss, this.lastCgroupBytes ?? 0);
    if (used < this.lastLimit.bytes * this.config.rssThreshold) {
      // Dropping below the threshold resets both the consecutive window and any
      // deferred exit: there is nothing to recover from.
      this.highMemorySince = null;
      this.deferredSince = null;
      return;
    }

    if (this.highMemorySince === null) {
      this.highMemorySince = now;
    }
    const overMs = now - this.highMemorySince;
    if (overMs < this.config.highRssMs || this.inWarmup(now)) {
      return;
    }
    this.evaluateRssExit(now, overMs);
  }

  /** One informational snapshot line (integers in MiB, no user data). */
  public onSnapshot(): void {
    const usage = this.memoryUsage();
    const limit = this.resolvedLimit();
    this.safeWrite(
      `mem rss=${mib(usage.rss)}` +
        ` heap=${mib(usage.heapUsed)}` +
        ` external=${mib(usage.external)}` +
        ` arrayBuffers=${mib(usage.arrayBuffers ?? 0)}` +
        ` cap=${mib(limit.bytes)}` +
        ` limit_source=${limit.source}\n`
    );
  }

  /**
   * Exit on sustained high memory, but let an in-flight publication finish first.
   *
   * While a publish is running the exit is deferred by at most
   * `publishGraceMs`; a publish that settles inside the window leads to a normal
   * exit on the next sample (`publish=idle ...`), and one that does not is
   * abandoned after the grace with `publish=in_flight_for_ms=... card=<id>`.
   */
  private evaluateRssExit(now: number, overMs: number): void {
    if (!this.publish.inFlight()) {
      this.exitFor('rss', { overMs });
      return;
    }
    if (this.deferredSince === null) {
      this.deferredSince = now;
    }
    if (now - this.deferredSince >= this.config.publishGraceMs) {
      this.exitFor('rss', { overMs });
    }
  }

  private inWarmup(now: number): boolean {
    return now - this.startedAt < this.config.warmupMs;
  }

  /** Limit from the last sample, or a fresh read when no sample has happened yet. */
  private resolvedLimit(): MemoryLimit {
    return this.lastLimit.bytes ? this.lastLimit : resolveMemoryLimit(this.readFile, this.env);
  }

  /**
   * Пишет строку и не даёт сбою stdout сорвать exit: если пайп закрыт, процесс
   * всё равно должен завершиться по причине watchdog'а.
   */
  private safeWrite(line: string): void {
    try {
      this.write(line);
    } catch {
      // stdout недоступен — молча продолжаем: exit важнее строки.
    }
  }

  /** Хранит только последние {@link RSS_SAMPLES_KEPT} сэмплов — памяти не растёт. */
  private rememberRss(rssBytes: number): void {
    this.recentRss.push(mib(rssBytes));
    if (this.recentRss.length > RSS_SAMPLES_KEPT) {
      this.recentRss.shift();
    }
  }

  /**
   * Writes one structured line (synchronously), counts the exit and ends the
   * process. Runs at most once.
   */
  private exitFor(reason: WatchdogExitReason, detail: { lateMs?: number; overMs?: number }): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.stop();

    const usage = this.memoryUsage();
    const limit = this.resolvedLimit();
    let cgroup = '';
    if (this.lastCgroupBytes !== null) {
      cgroup = ` cgroup=${mib(this.lastCgroupBytes)}`;
    }
    const window =
      reason === 'stall'
        ? ` last_tick_late_ms=${Math.round(detail.lateMs ?? 0)}`
        : ` over_limit_ms=${Math.round(detail.overMs ?? 0)}`;
    const recent = this.recentRss.length ? ` recent_rss=${this.recentRss.join(',')}` : '';
    let publishLine: string;
    try {
      publishLine = this.publish.describe();
    } catch {
      publishLine = 'unavailable';
    }
    const line =
      `mem watchdog exit reason=${reason}` +
      ` rss=${mib(usage.rss)}` +
      ` heap=${mib(usage.heapUsed)}` +
      ` external=${mib(usage.external)}` +
      ` arrayBuffers=${mib(usage.arrayBuffers ?? 0)}` +
      ` cap=${mib(limit.bytes)}` +
      ` limit_source=${limit.source}` +
      cgroup +
      recent +
      ` uptime_s=${Math.round(this.monotonic() / 1000)}` +
      window +
      ` publish=${publishLine}\n`;

    metrics.watchdog.exits.inc({ reason });
    this.safeWrite(line);
    this.exit(reason === 'stall' ? WATCHDOG_EXIT_STALL : WATCHDOG_EXIT_RSS);
  }
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Bootstrap entry point: builds the watchdog from env and arms it.
 * Returns `undefined` when disabled (`NODE_ENV=test` by default).
 *
 * `overrides` exists for specs: it lets them inject `exit`/`write` so no test ever
 * arms the real `process.exit`.
 */
export function startMemoryWatchdogFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Omit<MemoryWatchdogOptions, 'config'>> = {}
): MemoryWatchdog | undefined {
  const config = memoryWatchdogConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  const watchdog = new MemoryWatchdog({ config, env, ...overrides });
  watchdog.start();
  return watchdog;
}
