/** Максимальная прибавка к весу источника от взятых постов. */
export const WEIGHT_TAKEN_CAP = 2;

/** Шаг штрафа за жёсткий игнор (отклонил карточку). */
export const IGNORE_PENALTY_STEP = 0.08;

/** Шаг штрафа за мягкий игнор (карточка просто истекла в бэклоге). */
export const SOFT_IGNORE_PENALTY_STEP = 0.02;

/** Сколько жёстких игноров нужно, чтобы вообще включить паузу. */
export const COOLDOWN_MIN_HARD = 3;

/** Максимальный штраф от игноров (доля, на которую режем базовый вес). */
export const IGNORE_PENALTY_CAP = 0.8;

/** Нижняя граница веса. */
export const MIN_WEIGHT = 0.2;

/** Вес ниже этого — источник уходит в cooldown (пауза). */
export const PAUSE_WEIGHT = 0.35;

/** Длительность паузы источника, дней. */
export const COOLDOWN_DAYS = 7;

/** За сколько дней штраф от игноров полностью «тает». */
export const RECOVER_DAYS = 7;

/** Период полураспада положительного буста (взятые посты), дней. */
export const TAKEN_HALF_LIFE_DAYS = 21;

/** Через сколько дней без взятий история takenTotal делится пополам. */
export const TAKEN_STALE_DAYS = 45;

const DAY_MS = 86_400_000;

/**
 * Вес источника для ранжирования: стартует с 1, растёт логарифмически от
 * числа взятых постов (чем чаще владелец берёт из канала — тем выше канал
 * в выдаче предложки). Прибавка ограничена WEIGHT_TAKEN_CAP.
 */
export function computeSourceWeight(takenTotal: number): number {
  const taken = Number.isFinite(takenTotal) ? Math.max(0, Math.floor(takenTotal)) : 0;
  return 1 + Math.min(WEIGHT_TAKEN_CAP, Math.log2(1 + taken));
}

/** Состояние источника, влияющее на вес. */
export interface SourceInterest {
  takenTotal: number;
  ignoredTotal: number;
  softIgnoredTotal?: number;
  lastIgnoredAt?: Date | string | null;
  lastTakenAt?: Date | string | null;
}

/** Результат пересчёта веса. */
export interface SourceInterestState {
  weight: number;
  /** До какого времени источник на паузе (null — не на паузе). */
  cooldownUntil: Date | null;
}

const parseDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * Пересчёт веса по решениям владельца: взятые посты поднимают канал, игноры и
 * отклонения опускают. Штраф со временем «тает» (RECOVER_DAYS): то, что давно
 * не брали, постепенно возвращается в ротацию. Если вес падает ниже
 * PAUSE_WEIGHT, источник уходит в cooldown на COOLDOWN_DAYS.
 */
export function computeSourceInterest(
  source: SourceInterest,
  now: Date = new Date()
): SourceInterestState {
  // Положительный буст остывает: держится, только пока канал продолжают брать.
  const taken = Number.isFinite(source.takenTotal) ? Math.max(0, Math.floor(source.takenTotal)) : 0;
  const boost = Math.min(WEIGHT_TAKEN_CAP, Math.log2(1 + taken));
  const lastTakenAt = parseDate(source.lastTakenAt);
  const recency = lastTakenAt
    ? Math.pow(0.5, Math.max(0, now.getTime() - lastTakenAt.getTime()) / DAY_MS / TAKEN_HALF_LIFE_DAYS)
    : 0;
  const base = 1 + boost * recency;
  const ignored = Number.isFinite(source.ignoredTotal) ? Math.max(0, source.ignoredTotal) : 0;
  const soft = Number.isFinite(source.softIgnoredTotal) ? Math.max(0, source.softIgnoredTotal ?? 0) : 0;
  let penalty = Math.min(
    IGNORE_PENALTY_CAP,
    ignored * IGNORE_PENALTY_STEP + soft * SOFT_IGNORE_PENALTY_STEP
  );

  const lastIgnoredAt = parseDate(source.lastIgnoredAt);
  if (lastIgnoredAt) {
    const elapsedDays = Math.max(0, now.getTime() - lastIgnoredAt.getTime()) / DAY_MS;
    const recovery = Math.min(1, elapsedDays / RECOVER_DAYS);
    penalty *= 1 - recovery;
  }

  const weight = Math.max(MIN_WEIGHT, base * (1 - penalty));
  // Пауза — только когда накопились жёсткие игноры (не путаем «не успел» с «не надо»).
  const cooldownUntil =
    ignored >= COOLDOWN_MIN_HARD && weight < PAUSE_WEIGHT
      ? new Date(now.getTime() + COOLDOWN_DAYS * DAY_MS)
      : null;
  return { weight, cooldownUntil };
}

/** Итоговый вес сортировки кандидата: скор поста × вес источника. */
export function rankScore(score: number, weight: number | undefined): number {
  const safeWeight = Number.isFinite(weight) && (weight ?? 0) > 0 ? (weight as number) : 1;
  return (Number.isFinite(score) ? score : 0) * safeWeight;
}
