import { Inject, Injectable, Logger } from '@nestjs/common';
import { BOT } from '../../bot/providers/bot.provider';
import { Bot } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';
import { RANDOM, Random } from '../../../shared/random';
import {
  ENTITY_BACKOFF_BASE_MS,
  ENTITY_BACKOFF_CAP_MS,
  FLOOD_JITTER_MS,
} from '../constants/parser.constants';
import { mtprotoFloodGate } from '../../../shared/mtproto-flood-gate';
import { ParserClientService } from './parser-client.service';

/** Терминальные ошибки MTProto: ретраить бессмысленно, аккаунт в опасности. */
export class TerminalMtprotoError extends Error {
  constructor(public readonly code: string) {
    super(`Terminal MTProto error: ${code}`);
  }
}

/** Сырой текст ошибки: message, errorMessage и (для не-Error) сам объект. */
const rawText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  const errorMessage = (error as { errorMessage?: string })?.errorMessage;
  const fallback = error instanceof Error || error == null ? '' : String(error);
  return [message, errorMessage, fallback].filter(Boolean).join(' ');
};

/**
 * Секунды ожидания из ошибки Telegram: `FLOOD_WAIT_N`,
 * `A wait of N seconds is required` (так gramjs оборачивает FloodWaitError)
 * или поле `seconds` самого FloodWaitError.
 */
const isFloodWait = (error: unknown): number | null => {
  const raw = rawText(error);
  const numeric = raw.match(/FLOOD(?:_PREMIUM)?_WAIT_(\d+)/);
  if (numeric) return Number(numeric[1]);

  const text = raw.match(/A wait of (\d+) seconds/);
  if (text) return Number(text[1]);

  const seconds = (error as { seconds?: unknown })?.seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }
  return null;
};

/** Кэш сущностей не нашёл пир: CHANNEL_INVALID / «input entity». */
const isEntityMiss = (error: unknown): boolean =>
  /CHANNEL_INVALID|Could not find the input entity/.test(rawText(error));

const terminalCode = (error: unknown): string | null => {
  const raw = rawText(error);
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/.test(raw)) return 'AUTH_KEY_UNREGISTERED';
  if (/USER_DEACTIVATED(_BAN)?/.test(raw)) return 'USER_DEACTIVATED_BAN';
  return null;
};

/** Шаг экспоненциального бэкоффа для N-го подряд промаха, мс. */
export const entityBackoffMs = (fails: number): number =>
  Math.min(ENTITY_BACKOFF_BASE_MS * 2 ** Math.max(0, fails - 1), ENTITY_BACKOFF_CAP_MS);

/** Подпись сущности для лога: только числовой id, username наружу не пишем. */
const entityLabel = (entity: string | number | undefined): string => {
  if (entity == null) return '-';
  const key = String(entity);
  return /^-?\d+$/.test(key) ? key : '<username>';
};

/** Ключ бэкоффа: сырой пир (id/username в нижнем регистре), без маски из лога. */
const scopeKey = (entity: string | number | undefined): string =>
  String(entity ?? '-').toLowerCase();

/** Ключи кэша для сущности: marked id канала и «сырой» id. */
const entityKeys = (entity: string | number): string[] => {
  const key = String(entity);
  if (!/^-?\d+$/.test(key)) return [key.toLowerCase()];
  const marked = key.startsWith('-100') ? key : `-100${key.replace(/^-/, '')}`;
  const raw = marked.replace(/^-100/, '');
  return [key, marked, raw].filter((value, index, all) => all.indexOf(value) === index);
};

/**
 * Обёртка MTProto-вызовов парсера: глобальная пауза по FloodWait (дедлайн,
 * переживает cron/ретраи), бэкофф промахов сущности с перерезолвом кэша,
 * jitter-паузы и stop-and-alert для терминальных ошибок аккаунта.
 */
@Injectable()
export class ParserMtprotoGuard {
  private readonly logger = new Logger(ParserMtprotoGuard.name);
  private alerted = false;

  /** Промахи сущности: scope → {подряд промахов, до какого момента молчим}. */
  private readonly entityBackoff = new Map<string, { fails: number; untilMs: number }>();

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
    @Inject(RANDOM) private readonly random: Random,
    private readonly parserClient?: ParserClientService
  ) {}

  /** MTProto на паузе по FloodWait (cron-циклы не должны трогать Telegram). */
  public isBlocked(): boolean {
    return mtprotoFloodGate.isBlocked();
  }

  /** Дедлайн паузы (epoch ms) или `null`, если паузы нет. */
  public blockedUntil(): number | null {
    return mtprotoFloodGate.until();
  }

  /**
   * Выполняет MTProto-операцию с защитой от флуда.
   * Возвращает undefined, если операция не удалась либо MTProto на паузе
   * (терминальные ошибки пробрасываются после алерта).
   *
   * @param operation имя операции для лога
   * @param fn сам вызов
   * @param entity пир вызова (marked id/username): по нему сбрасывается кэш
   *   сущности при промахе и ведётся бэкофф
   */
  async run<T>(
    operation: string,
    fn: () => Promise<T>,
    entity?: string | number
  ): Promise<T | undefined> {
    const scope = `${operation}:${scopeKey(entity)}`;
    if (this.isBlocked()) return undefined;

    // Промах сущности уже в бэкоффе — не дёргаем Telegram до его конца.
    const backoff = this.entityBackoff.get(scope);
    if (backoff && backoff.untilMs > Date.now()) return undefined;

    // Перерезолв делается заново на каждой разрешённой попытке (не «навсегда»
    // после первого промаха): кэш мог снова протухнуть.
    let reran = false;

    for (;;) {
      try {
        const result = await fn();
        this.entityBackoff.delete(scope);
        return result;
      } catch (error) {
        const terminal = terminalCode(error);
        if (terminal) {
          await this.alertOwner(terminal);
          throw new TerminalMtprotoError(terminal);
        }

        const floodSec = isFloodWait(error);
        if (floodSec !== null) {
          this.enterFloodWait(operation, floodSec);
          return undefined;
        }

        if (isEntityMiss(error)) {
          if (!reran && entity !== undefined) {
            // Первый промах эпизода: сбрасываем кэш и перерезолвляем один раз.
            reran = true;
            this.invalidateEntity(entity);
            continue;
          }
          this.scheduleEntityBackoff(operation, scope, entity);
          return undefined;
        }

        this.logger.warn(`Parser MTProto ${operation} failed: ${describe(error)}`);
        return undefined;
      }
    }
  }

  /** Пауза с jitterом между MTProto-вызовами (анти-«поезд»). */
  async pace(baseMs: number, jitterMs = 500): Promise<void> {
    const jitter = Math.floor(this.random.next() * jitterMs);
    await this.sleep(baseMs + jitter);
  }

  /** Дедлайн FloodWait: одна строка в лог на каждое новое ожидание. */
  private enterFloodWait(operation: string, seconds: number): void {
    const jitterMs = Math.floor(this.random.next() * FLOOD_JITTER_MS);
    const untilMs = mtprotoFloodGate.block(seconds, jitterMs);
    // То же (или меньшее) ожидание, о котором уже знаем: пауза не продлевается
    // и лог не дублируется — дедуп по абсолютному значению ожидания.
    if (untilMs === null) return;
    this.logger.warn(
      `Parser MTProto ${operation}: FLOOD_WAIT ${seconds}s — пауза MTProto до ${new Date(
        untilMs
      ).toISOString()}`
    );
  }

  /** Бэкофф промаха сущности: шаг экспоненциальный, лог — одна строка на шаг. */
  private scheduleEntityBackoff(operation: string, scope: string, entity?: string | number): void {
    const fails = (this.entityBackoff.get(scope)?.fails ?? 0) + 1;
    const delayMs = entityBackoffMs(fails);
    this.entityBackoff.set(scope, { fails, untilMs: Date.now() + delayMs });
    this.logger.warn(
      `Parser MTProto ${operation}: пир ${entityLabel(entity)} не резолвится (CHANNEL_INVALID/input entity), бэкофф ${delayMs}ms (подряд ${fails})`
    );
  }

  /**
   * Сбрасывает закэшированный пир в gramjs (in-memory entity cache и строки
   * сессии), чтобы следующий вызов перерезолвил его через Telegram.
   */
  private invalidateEntity(entity: string | number): void {
    const client = this.parserClient?.client() as unknown as
      | {
          _entityCache?: { cacheMap?: Map<string, unknown> };
          session?: { _entities?: Set<unknown[]> };
        }
      | undefined;
    if (!client) return;

    const keys = entityKeys(entity);
    for (const key of keys) {
      client._entityCache?.cacheMap?.delete(key);
    }

    const rows = client.session?._entities;
    if (rows && typeof rows.delete === 'function') {
      for (const row of Array.from(rows)) {
        // Строка сессии MemorySession: [markedId, hash, username, phone, name].
        if (keys.includes(String(row[0])) || keys.includes(String(row[2]))) {
          rows.delete(row);
        }
      }
    }
  }

  private async alertOwner(code: string): Promise<void> {
    if (this.alerted) return;
    this.alerted = true;
    this.logger.error(`Parser: terminal MTProto error ${code} — конвейер остановлен`);
    try {
      await this.bot.api.sendMessage(
        this.config.ownerId,
        `⛔️ Парсер остановлен: терминальная ошибка MTProto (${code}). Проверь аккаунт-парсер.`
      );
    } catch (error) {
      this.logger.error(`Parser: cannot alert owner: ${error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
