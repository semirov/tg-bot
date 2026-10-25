import { DELIVERY_ATTEMPT_LIMIT, DELIVERY_RETRY_BACKOFF_MS, ObservedStatus } from '../constants/parser.constants';

/**
 * Класс сбоя доставки — как с ним поступает селектор:
 * - `terminal` — повторять нечего, строка сразу `rejected`;
 * - `attempt` — медиа-сбой (битый `file_reference` и т.п.): тратит попытку,
 *   после `DELIVERY_ATTEMPT_LIMIT` строка `rejected`;
 * - `transient` — сеть/флуд/неизвестный сбой: строка остаётся в пуле, попытку
 *   не тратит (здоровый пост не должен приговариваться за сетевой сбой).
 */
export type DeliveryFailureClass = 'terminal' | 'attempt' | 'transient';

/** Повторять бессмысленно: медиа физически не годится / поста нет / нет источника. */
const TERMINAL_REASONS = new Set(['media-too-large', 'message-gone', 'source-missing']);

/** Медиа не удалось получить: именно эти сбои ограничиваем счётчиком попыток. */
const ATTEMPT_REASONS = new Set(['media-fetch-failed', 'media-download-empty']);

/** Сеть/флуд по сырому тексту ошибки Telegram: это транзиент, а не дефект строки. */
const TRANSIENT_ERROR = /FLOOD(?:_PREMIUM)?_WAIT_|A wait of \d+ seconds|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|TimeoutError|TimedOutError|RPCError: 50[03]/i;

/**
 * Причина сбоя доставки → класс. Неизвестная причина считается транзиентной:
 * непонятный сбой не повод отклонять пост (молчаливого «приговора» нет).
 */
export const classifyDeliveryFailure = (reason: string | null | undefined): DeliveryFailureClass => {
  const key = reason ?? '';
  if (TERMINAL_REASONS.has(key)) return 'terminal';
  if (ATTEMPT_REASONS.has(key)) return 'attempt';
  return 'transient';
};

/**
 * Причина сбоя MTProto-вызова медиа по сырой ошибке: `null` — вызова не было
 * (гейт/бэкофф пира), флуд и сеть — транзиентные классы, остальное — медиа-сбой
 * (например `FILE_REFERENCE_EXPIRED` — ссылка на файл протухла).
 */
export const mediaFailureReason = (error: unknown): string => {
  if (error == null) return 'mtproto-blocked';
  const text = error instanceof Error ? error.message : String(error);
  if (/FLOOD(?:_PREMIUM)?_WAIT_|A wait of \d+ seconds/i.test(text)) return 'flood-wait';
  if (TRANSIENT_ERROR.test(text)) return 'network';
  return 'media-fetch-failed';
};

/** Поля строки, которые меняет исход доставки. */
export interface DeliveryAttemptState {
  status: ObservedStatus;
  rejectReason: string | null;
  deliveryAttempts: number | null;
  lastDeliveryFailureAt: Date | null;
}

export interface DeliveryFailureOutcome {
  rejected: boolean;
  attempts: number;
}

/**
 * Проставляет строке итог провалившейся доставки (мутирует её, но не сохраняет).
 * Возвращает решение для лога: отклонена ли строка и сколько попыток накоплено.
 */
export const applyDeliveryFailure = (
  row: DeliveryAttemptState,
  reason: string | null | undefined,
  now: Date
): DeliveryFailureOutcome => {
  const key = reason ?? '';
  const failure = classifyDeliveryFailure(key);
  const attempts = row.deliveryAttempts ?? 0;

  if (failure === 'terminal') {
    row.status = ObservedStatus.REJECTED;
    row.rejectReason = key;
    return { rejected: true, attempts };
  }

  row.lastDeliveryFailureAt = now;
  if (failure === 'transient') {
    // Попытку не тратим: строка вернётся в пул после бэкоффа.
    row.status = ObservedStatus.SCORED;
    row.rejectReason = null;
    return { rejected: false, attempts };
  }

  row.deliveryAttempts = attempts + 1;
  const rejected = row.deliveryAttempts >= DELIVERY_ATTEMPT_LIMIT;
  row.status = rejected ? ObservedStatus.REJECTED : ObservedStatus.SCORED;
  row.rejectReason = rejected ? key : null;
  return { rejected, attempts: row.deliveryAttempts };
};

/** Строка проваливалась меньше бэкоффа назад — в этом окне её не трогаем. */
export const isDeliveryBackedOff = (
  row: { lastDeliveryFailureAt?: Date | null },
  now: Date,
  backoffMs: number = DELIVERY_RETRY_BACKOFF_MS
): boolean => {
  const failedAt = row.lastDeliveryFailureAt?.getTime();
  return failedAt != null && now.getTime() - failedAt < backoffMs;
};
