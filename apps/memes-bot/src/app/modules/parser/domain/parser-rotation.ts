import {
  SWEEP_ACTIVE_MIN_INTERVAL_MS,
  SWEEP_WEB_ONLY_MIN_INTERVAL_MS,
  SourceStatus,
} from '../constants/parser.constants';

/**
 * Минимум полей источника, нужный ротации (структурно совместим с
 * `SourceChannelEntity`, но домен не зависит от TypeORM-сущности).
 */
export interface RotationSource {
  id: number;
  status: SourceStatus | string;
  lastSweepAt?: Date | string | null;
  statsUpdatedAt?: Date | string | null;
}

/** Метка времени в мс (или `null`): принимает Date и строку из БД. */
const timeOf = (value: Date | string | null | undefined): number | null => {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/** Интервал повторного свипа по статусу источника. */
export const sweepIntervalMs = (status: SourceStatus | string): number =>
  status === SourceStatus.WEB_ONLY ? SWEEP_WEB_ONLY_MIN_INTERVAL_MS : SWEEP_ACTIVE_MIN_INTERVAL_MS;

/**
 * Пора ли свипать источник: ни разу не свипали или интервал статуса истёк.
 * `lastSweepAt` — «последняя попытка истории», а не «последние посты»:
 * иначе источник без новых постов навсегда оставался бы в голове ротации.
 */
export const isSweepDue = (source: RotationSource, nowMs: number): boolean => {
  const last = timeOf(source.lastSweepAt);
  if (last === null) return true;
  return nowMs - last >= sweepIntervalMs(source.status);
};

/**
 * Порядок свипа: сначала активные, затем самые давние (`lastSweepAt` ASC,
 * null — первыми), tie-break по `id` ASC (детерминизм при равных метках).
 */
export const compareSweepOrder = (a: RotationSource, b: RotationSource): number => {
  const rankA = a.status === SourceStatus.ACTIVE ? 0 : 1;
  const rankB = b.status === SourceStatus.ACTIVE ? 0 : 1;
  if (rankA !== rankB) return rankA - rankB;

  const atA = timeOf(a.lastSweepAt);
  const atB = timeOf(b.lastSweepAt);
  if (atA !== atB) {
    if (atA === null) return -1;
    if (atB === null) return 1;
    return atA - atB;
  }
  return a.id - b.id;
};

/**
 * Порядок прогона статистики: `statsUpdatedAt` ASC с NULLS FIRST (Postgres
 * для ASC кладёт NULL последними, поэтому сортируем в памяти), tie-break `id` ASC.
 */
export const compareStatsOrder = (a: RotationSource, b: RotationSource): number => {
  const atA = timeOf(a.statsUpdatedAt);
  const atB = timeOf(b.statsUpdatedAt);
  if (atA !== atB) {
    if (atA === null) return -1;
    if (atB === null) return 1;
    return atA - atB;
  }
  return a.id - b.id;
};

const isActive = (source: RotationSource): boolean => source.status === SourceStatus.ACTIVE;

/** Порция свипа: выбранные источники и сколько отсеклось интервалом статуса. */
export interface SweepSlice<T extends RotationSource> {
  selected: T[];
  skippedInterval: number;
}

/**
 * Порция свипа с квотой по тирам (TGB-125, follow-up).
 *
 * Каждый тир отдаёт до `tierQuota` своих самых давних due-источников
 * (`compareSweepOrder` внутри тира), затем свободные слоты добирает другой тир
 * — всего не больше `limit`. Финальный список: `active` первыми (внутри —
 * LRU), затем `web_only`; это же порядок, в котором идут history-вызовы.
 *
 * Зачем квота: 78 активных с интервалом 4 ч иначе съедали всю порцию, а
 * web_only (нет live-событий, только history sweep) не получали ни одного слота.
 */
export const selectSweepSlice = <T extends RotationSource>(
  sources: T[],
  nowMs: number,
  tierQuota: number,
  limit: number
): SweepSlice<T> => {
  const due = sources.filter((source) => isSweepDue(source, nowMs));
  const active = due.filter(isActive).sort(compareSweepOrder);
  const webOnly = due.filter((source) => !isActive(source)).sort(compareSweepOrder);

  const selected = [
    ...active.slice(0, tierQuota),
    ...webOnly.slice(0, tierQuota),
  ];
  // Свободные слоты (тир короче квоты): добираем из остатков по общему LRU.
  if (selected.length < limit) {
    const rest = [...active.slice(tierQuota), ...webOnly.slice(tierQuota)].sort(compareSweepOrder);
    selected.push(...rest.slice(0, limit - selected.length));
  }

  // Порядок вызовов: active первыми, затем web_only (уже отсортированы внутри).
  selected.sort(compareSweepOrder);
  return { selected: selected.slice(0, limit), skippedInterval: sources.length - due.length };
};
