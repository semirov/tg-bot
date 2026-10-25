import { Inject, Injectable, Logger } from '@nestjs/common';
import { BOT } from '../../bot/providers/bot.provider';
import { Bot } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';
import { RANDOM, Random } from '../../../shared/random';
import {
  ENTITY_BACKOFF_BASE_MS,
  ENTITY_BACKOFF_CAP_MS,
  ENTITY_BROKEN_RETRY_MS,
  ENTITY_REFRESH_COOLDOWN_MS,
  ENTITY_REFRESH_DIALOG_LIMIT,
  FLOOD_JITTER_MS,
} from '../constants/parser.constants';
import { mtprotoFloodGate } from '../../../shared/mtproto-flood-gate';
import { ParserClientService } from './parser-client.service';
import { canonicalPeerKey, peerCacheKeys, peerLabel } from '../domain/parser-peer-key';

/** Терминальные ошибки MTProto: ретраить бессмысленно, аккаунт в опасности. */
export class TerminalMtprotoError extends Error {
  constructor(public readonly code: string) {
    super(`Terminal MTProto error: ${code}`);
  }
}

/**
 * Итог попытки восстановить стор сущностей:
 * - `refreshed` — `getDialogs` сходил успешно;
 * - `failed` — вызов был и упал (транзиентная ошибка/флуд);
 * - `skipped` — вызова не было (окно кулдауна, single flight, пауза, нет клиента).
 */
export type EntityRefreshOutcome = 'refreshed' | 'failed' | 'skipped';

/** Потолок состояния по пирам: username-флуд не должен растить карты без границы. */
const PEER_STATE_LIMIT = 5000;

/** Простой записи пира, после которого её можно выбросить (счётчик шагов неактуален). */
const PEER_STATE_TTL_MS = 60 * 60 * 1000;

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

/**
 * Ключ бэкоффа промахов. С пиром — канонический пир (`canonicalPeerKey`):
 * промах на одном вызове (`getHistory`, `getMessages:ids`, `getFullChannel`)
 * означает, что пир не резолвится вообще, и остальные вызовы по нему
 * (в т.ч. по другой форме id) тоже бессмысленны. Без пира — операция:
 * перерезолвить нечего, но и повторять её незачем.
 */
const peerKey = (entity: string | number): string => `peer:${canonicalPeerKey(entity)}`;

const backoffKey = (operation: string, entity?: string | number): string =>
  entity === undefined ? `op:${operation}` : peerKey(entity);

/**
 * Обёртка MTProto-вызовов парсера: глобальная пауза по FloodWait (дедлайн,
 * переживает cron/ретраи), бэкофф промахов сущности с восстановлением стора
 * через `getDialogs`, jitter-паузы и stop-and-alert для терминальных ошибок.
 */
@Injectable()
export class ParserMtprotoGuard {
  private readonly logger = new Logger(ParserMtprotoGuard.name);
  private alerted = false;

  /** Промахи: ключ (пир или операция) → {подряд промахов, до какого момента молчим, когда трогали}. */
  private readonly entityBackoff = new Map<
    string,
    { fails: number; untilMs: number; touchedAtMs: number }
  >();

  /** Мёртвые пиры (refresh реально сходил и не помог) → до какого момента свип не трогает. */
  private readonly brokenPeers = new Map<string, { untilMs: number; touchedAtMs: number }>();

  /** Когда последний раз пробовали перезаполнить стор сущностей, epoch ms. */
  private lastEntityRefreshAt = 0;

  /** Перезаполнение стора в полёте: параллельные промахи ждут один вызов. */
  private entityRefreshInFlight?: Promise<EntityRefreshOutcome>;

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
   * @param entity пир вызова (marked id/username): по нему восстанавливается
   *   стор сущностей при промахе и ведётся бэкофф
   */
  async run<T>(
    operation: string,
    fn: () => Promise<T>,
    entity?: string | number
  ): Promise<T | undefined> {
    const key = backoffKey(operation, entity);
    this.prunePeerState();
    if (this.isBlocked()) return undefined;

    // Пир уже в бэкоффе — не дёргаем Telegram до конца шага (лог шага был один).
    if (this.isBackedOff(key)) return undefined;

    // Перерезолв делается заново на каждой разрешённой попытке (не «навсегда»
    // после первого промаха): кэш мог снова протухнуть.
    let reran = false;
    let refreshOutcome: EntityRefreshOutcome | undefined;

    for (;;) {
      // Пауза могла включиться внутри refresh-а (FLOOD_WAIT от getDialogs):
      // повтор после промаха уже не должен трогать Telegram.
      if (this.isBlocked()) return undefined;
      try {
        const result = await fn();
        this.entityBackoff.delete(key);
        this.brokenPeers.delete(key);
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
            // Первый промах эпизода: сбрасываем ТОЛЬКО in-memory кэш пира,
            // перезаполняем стор через getDialogs и повторяем один раз.
            reran = true;
            this.dropCachedPeer(entity);
            refreshOutcome = await this.refreshEntityStore(operation);
            if (refreshOutcome === 'refreshed') {
              // gramjs берёт ПЕРВУЮ строку пира: свежий access hash должен
              // оказаться единственным, иначе устаревший выигрывает навсегда.
              this.dropStalePeerRows(entity);
            }
            continue;
          }
          this.scheduleEntityBackoff(operation, key, entity, refreshOutcome);
          return undefined;
        }

        this.logger.warn(`Parser MTProto ${operation} failed: ${describe(error)}`);
        return undefined;
      }
    }
  }

  /**
   * Пир признан мёртвым: refresh **реально сходил** и не помог, либо пир ждёт
   * следующего окна refresh-а. Свип не дёргает такой пир до горизонта; один
   * мёртвый пир не останавливает свип остальных источников.
   */
  public isPeerBroken(entity: string | number): boolean {
    const now = Date.now();
    this.prunePeerState();
    const state = this.brokenPeers.get(peerKey(entity));
    return state !== undefined && state.untilMs > now;
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

  /**
   * Бэкофф промаха сущности: шаг экспоненциальный, лог — одна строка на шаг.
   *
   * Пауза свипа (горизонт «мёртвого» пира) аргументируется итогом refresh-а:
   * часовой горизонт — только когда `getDialogs` реально сходил и пир всё равно
   * не поднялся. Пропущенный (окно/single flight) или упавший refresh не
   * приговор: ждём до следующего окна, иначе один транзиентный сбой `getDialogs`
   * выключил бы все затронутые источники на час (симптом инцидента).
   */
  private scheduleEntityBackoff(
    operation: string,
    key: string,
    entity: string | number | undefined,
    outcome: EntityRefreshOutcome | undefined
  ): void {
    const now = Date.now();
    const fails = (this.entityBackoff.get(key)?.fails ?? 0) + 1;
    const delayMs = entityBackoffMs(fails);
    this.setPeerState(this.entityBackoff, key, {
      fails,
      untilMs: now + delayMs,
      touchedAtMs: now,
    });

    let parkMs = 0;
    let reason = 'без пира';
    if (entity !== undefined) {
      if (outcome === 'refreshed') {
        parkMs = ENTITY_BROKEN_RETRY_MS;
        reason = 'refresh не помог';
      } else {
        parkMs = this.cooldownLeftMs(now);
        reason = outcome === 'failed' ? 'refresh не удался' : 'refresh пропущен';
      }
      if (parkMs > 0) {
        this.setPeerState(this.brokenPeers, key, { untilMs: now + parkMs, touchedAtMs: now });
      } else {
        this.brokenPeers.delete(key);
      }
    }

    this.logger.warn(
      `Parser MTProto ${operation}: пир ${peerLabel(entity)} не резолвится (CHANNEL_INVALID/input entity), бэкофф ${delayMs}ms, свип-пауза ${parkMs}ms (${reason}, подряд ${fails})`
    );
  }

  /** Ключ в бэкоффе и шаг ещё не истёк. */
  private isBackedOff(key: string): boolean {
    const state = this.entityBackoff.get(key);
    return state !== undefined && state.untilMs > Date.now();
  }

  /** Сколько осталось до следующего разрешённого refresh-а, мс. */
  private cooldownLeftMs(now: number): number {
    return Math.max(0, this.lastEntityRefreshAt + ENTITY_REFRESH_COOLDOWN_MS - now);
  }

  /** Чистит протухшие записи: состояние по пирам не должно течь. */
  private prunePeerState(): void {
    const now = Date.now();
    for (const [key, state] of this.entityBackoff) {
      if (now - state.touchedAtMs > PEER_STATE_TTL_MS) this.entityBackoff.delete(key);
    }
    for (const [key, state] of this.brokenPeers) {
      if (now - state.touchedAtMs > PEER_STATE_TTL_MS) this.brokenPeers.delete(key);
    }
  }

  /** Запись в карту с потолком: самые старые ключи вытесняются (FIFO). */
  private setPeerState<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > PEER_STATE_LIMIT) {
      for (const oldest of map.keys()) {
        map.delete(oldest);
        break;
      }
    }
  }

  /**
   * Сбрасывает ТОЛЬКО in-memory кэш пира (`_entityCache.cacheMap`).
   *
   * Строки `session._entities` (`MemorySession`) не трогаем: их удаление —
   * регрессия TGB-118 (пир переставал резолвиться до рестарта). Строки не
   * сериализуются в `StringSession`, поэтому рестарт их не восстанавливает —
   * после рестарта пир возвращает только новый резолв (`getDialogs` /
   * `ResolveUsername`), см. `refreshEntityStore`.
   */
  private dropCachedPeer(entity: string | number): void {
    const cacheMap = this.entityCacheMap();
    if (!cacheMap) return;
    for (const key of peerCacheKeys(entity)) cacheMap.delete(key);
  }

  /**
   * Убирает УСТАРЕВШИЕ дубли строк пира, оставляя самую свежую.
   *
   * gramjs ищет пир по `session._entities` в порядке вставки и берёт первую
   * строку, поэтому после успешного refresh-а старый access hash побеждал бы
   * новый и пир не выздоравливал бы никогда. Удаляем только дубли этого пира.
   */
  private dropStalePeerRows(entity: string | number): void {
    const rows = this.sessionEntityRows();
    if (!rows || rows.size < 2) return;
    const keys = new Set(peerCacheKeys(entity));

    let newest: unknown[] | undefined;
    for (const row of rows) {
      if (this.rowMatchesPeer(row, keys)) newest = row;
    }
    if (!newest) return;

    for (const row of Array.from(rows)) {
      if (row !== newest && this.rowMatchesPeer(row, keys)) rows.delete(row);
    }
  }

  /** Строка сессии MemorySession: [id, hash, username, phone, name]. */
  private rowMatchesPeer(row: unknown, keys: Set<string>): boolean {
    if (!Array.isArray(row)) return false;
    const id = row[0] == null ? '' : String(row[0]).toLowerCase();
    const username = row[2] == null ? '' : String(row[2]).toLowerCase();
    return (id !== '' && keys.has(id)) || (username !== '' && keys.has(username));
  }

  /**
   * Перезаполняет стор сущностей gramjs: `messages.GetDialogs` возвращает
   * `chats`/`users` с access hash-ами, и gramjs кладёт их и в `_entityCache`,
   * и в строки сессии (`_call` → `session.processEntities` + `_entityCache.add`).
   * Это документированный путь, которым пир возвращается в резолв без рестарта.
   *
   * `limit: 200` — два запроса gramjs (чанк по 100), осознанно: один запрос
   * покрыл бы лишь первую сотню подписок, а refresh нужен всем источникам.
   * Вызов не чаще раза в `ENTITY_REFRESH_COOLDOWN_MS`, single-flight: пачка
   * промахов по всем источникам даёт один refresh, а не по одному на пир.
   */
  private async refreshEntityStore(operation: string): Promise<EntityRefreshOutcome> {
    if (this.entityRefreshInFlight) return this.entityRefreshInFlight;
    if (this.isBlocked()) return 'skipped';
    if (Date.now() - this.lastEntityRefreshAt < ENTITY_REFRESH_COOLDOWN_MS) return 'skipped';

    const client = this.parserClient?.client() as unknown as
      | { getDialogs?: (params: { limit: number }) => Promise<unknown> }
      | undefined;
    if (typeof client?.getDialogs !== 'function') return 'skipped';

    this.lastEntityRefreshAt = Date.now();
    this.entityRefreshInFlight = this.runEntityRefresh(operation, {
      getDialogs: client.getDialogs.bind(client),
    });

    try {
      return await this.entityRefreshInFlight;
    } finally {
      this.entityRefreshInFlight = undefined;
    }
  }

  private async runEntityRefresh(
    operation: string,
    client: { getDialogs: (params: { limit: number }) => Promise<unknown> }
  ): Promise<EntityRefreshOutcome> {
    try {
      await client.getDialogs({ limit: ENTITY_REFRESH_DIALOG_LIMIT });
    } catch (error) {
      const floodSec = isFloodWait(error);
      if (floodSec !== null) {
        this.enterFloodWait('getDialogs', floodSec);
        return 'failed';
      }
      this.logger.warn(
        `Parser MTProto ${operation}: перезаполнение стора сущностей не удалось: ${describe(error)}`
      );
      return 'failed';
    }

    this.logger.log(
      `Parser MTProto ${operation}: стор сущностей перезаполнен (getDialogs, limit=${ENTITY_REFRESH_DIALOG_LIMIT})`
    );
    return 'refreshed';
  }

  /** In-memory кэш сущностей gramjs (внутренний, но стабильный в 2.x). */
  private entityCacheMap(): Map<string, unknown> | undefined {
    const cache = this.parserClient?.client() as unknown as
      | { _entityCache?: { cacheMap?: Map<string, unknown> } }
      | undefined;
    return cache?._entityCache?.cacheMap;
  }

  /** Строки сессии gramjs: `Set<[id, hash, username, phone, name]>`. */
  private sessionEntityRows(): Set<unknown[]> | undefined {
    const client = this.parserClient?.client() as unknown as
      | { session?: { _entities?: Set<unknown[]> } }
      | undefined;
    return client?.session?._entities;
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
