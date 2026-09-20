import { SourceCategory } from '../constants/parser.constants';
import { rankScore } from './parser-source-weight';

/** Кандидат на выбор селектором. */
export interface SelectCandidate {
  id: number;
  sourceChatId: number;
  category: SourceCategory | string;
  score: number;
  stage: string;
}

/** Настройки квот и ранжирования. */
export interface QuotaRules {
  /** Постов в сутки (0 = безлимит). */
  dailyLimit: number;
  /** Максимум постов с источника за сутки (0 = безлимит). */
  sourceDailyCap: number;
  cringeShare: number;
  /** Темп на один прогон селектора (0/undefined → DEFAULT_SELECT_LIMIT). */
  selectLimit?: number;
  /** Веса источников по chatId (из решений владельца). */
  weights?: Record<string, number>;
}

/** Счётчики уже выбранных за сутки (по кандидатам). */
export interface DayCounters {
  perSource: Record<string, number>;
  cringe: number;
  total: number;
}

/** Пост, расходующий дневную квоту (уже доставленный сегодня). */
export interface TodayDelivered {
  sourceChatId: number;
  category: SourceCategory | string;
  cringe: boolean;
}

/** Темп на прогон по умолчанию, если правила его не задали. */
export const DEFAULT_SELECT_LIMIT = 15;

/** Собирает счётчики за сегодня из списка доставленных постов. */
export function buildDayCounters<T extends TodayDelivered>(
  delivered: ReadonlyArray<T>,
  startOfDay: Date,
  deliveredAt: (item: T) => Date
): DayCounters {
  const perSource: Record<string, number> = {};
  let cringe = 0;
  let total = 0;
  for (const item of delivered) {
    const at = deliveredAt(item);
    if (at.getTime() < startOfDay.getTime()) continue;
    total += 1;
    perSource[item.sourceChatId] = (perSource[item.sourceChatId] ?? 0) + 1;
    if (item.cringe) cringe += 1;
  }
  return { perSource, cringe, total };
}

export const isCringeCategory = (category: SourceCategory | string): boolean =>
  category === SourceCategory.CRINGE;

const perRunLimit = (rules: QuotaRules): number =>
  rules.selectLimit != null && rules.selectLimit > 0 ? Math.floor(rules.selectLimit) : DEFAULT_SELECT_LIMIT;

/** Свободная квота кринжа на сегодня (безлимит → темп прогона). */
export function cringeQuotaLeft(rules: QuotaRules, counters: DayCounters): number {
  if (rules.dailyLimit <= 0) return perRunLimit(rules);
  const cringeLimit = Math.floor(rules.dailyLimit * rules.cringeShare);
  return Math.max(0, cringeLimit - counters.cringe);
}

/**
 * Сколько кандидатов можно отобрать в этом прогоне. При безлимите
 * (dailyLimit<=0) ограничение — только темп прогона.
 */
export function dailyLeft(rules: QuotaRules, counters: DayCounters): number {
  const perRun = perRunLimit(rules);
  if (rules.dailyLimit <= 0) return perRun;
  return Math.min(Math.max(0, rules.dailyLimit - counters.total), perRun);
}

/**
 * Отбор кандидатов: сортировка по скору с учётом веса источника
 * (score × weight — каналы, посты которых владелец чаще берёт, идут выше),
 * затем квоты. При dailyLimit=0 общий лимит отсутствует — за прогон
 * выбирается не больше selectLimit, чтобы не флудить Telegram. Кринж-резерв
 * работает только при конечной дневной квоте.
 */
export function pickByFairness(
  candidates: ReadonlyArray<SelectCandidate>,
  rules: QuotaRules,
  counters: DayCounters
): number[] {
  const remainingTotal = dailyLeft(rules, counters);
  if (remainingTotal === 0) return [];

  const remainingCringe =
    rules.dailyLimit <= 0 ? Number.POSITIVE_INFINITY : cringeQuotaLeft(rules, counters);
  const cringeEligible = candidates.filter((candidate) => isCringeCategory(candidate.category)).length;
  const memesLimit =
    rules.dailyLimit > 0 && cringeEligible > 0 ? remainingTotal - remainingCringe : remainingTotal;
  const sourceCap = new Map<string, number>();
  const perCategoryCount = { memes: 0, cringe: 0 };

  const sorted = [...candidates].sort((a, b) => {
    const weightA = rules.weights?.[String(a.sourceChatId)];
    const weightB = rules.weights?.[String(b.sourceChatId)];
    const rankA = rankScore(a.score, weightA);
    const rankB = rankScore(b.score, weightB);
    if (rankB !== rankA) return rankB - rankA;
    if (b.score !== a.score) return b.score - a.score;
    return a.id - b.id;
  });
  const picked: number[] = [];

  for (const candidate of sorted) {
    if (picked.length >= remainingTotal) break;

    const perSourceKey = String(candidate.sourceChatId);
    const usedSource = (counters.perSource[perSourceKey] ?? 0) + (sourceCap.get(perSourceKey) ?? 0);
    if (rules.sourceDailyCap > 0 && usedSource >= rules.sourceDailyCap) continue;

    const cringe = isCringeCategory(candidate.category);
    if (cringe) {
      if (perCategoryCount.cringe >= remainingCringe) continue;
      perCategoryCount.cringe += 1;
    } else {
      if (perCategoryCount.memes >= memesLimit) continue;
      perCategoryCount.memes += 1;
    }

    sourceCap.set(perSourceKey, (sourceCap.get(perSourceKey) ?? 0) + 1);
    picked.push(candidate.id);
  }

  return picked;
}

/**
 * Дедуп кандидатов внутри батча: одинаковое медиа (fileUniqueId или хеш)
 * считается дублем — остаётся лучший по score, остальные отбрасываются.
 */
export function dedupBatch(
  candidates: ReadonlyArray<{ id: number; score: number; fileKey: string | null }>
): number[] {
  const byKey = new Map<string, { id: number; score: number }>();
  for (const candidate of candidates) {
    if (!candidate.fileKey) {
      byKey.set(`id:${candidate.id}`, { id: candidate.id, score: candidate.score });
      continue;
    }
    const existing = byKey.get(candidate.fileKey);
    if (!existing || candidate.score > existing.score) {
      byKey.set(candidate.fileKey, { id: candidate.id, score: candidate.score });
    }
  }
  return [...byKey.values()].map((v) => v.id);
}
