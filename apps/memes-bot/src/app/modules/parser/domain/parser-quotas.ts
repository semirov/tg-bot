import { SourceCategory } from '../constants/parser.constants';

/** Кандидат на выбор селектором. */
export interface SelectCandidate {
  id: number;
  sourceChatId: number;
  category: SourceCategory | string;
  score: number;
  stage: string;
}

/** Настройки квот. */
export interface QuotaRules {
  dailyLimit: number;
  sourceDailyCap: number;
  cringeShare: number;
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

/** Свободная квота кринжа на сегодня. */
export function cringeQuotaLeft(rules: QuotaRules, counters: DayCounters): number {
  const cringeLimit = Math.floor(rules.dailyLimit * rules.cringeShare);
  return Math.max(0, cringeLimit - counters.cringe);
}

/** Свободный общий остаток дня. */
export function dailyLeft(rules: QuotaRules, counters: DayCounters): number {
  return Math.max(0, rules.dailyLimit - counters.total);
}

/**
 * Взвешенный round-robin по источникам: кандидаты сортируются по score,
 * но источник не может занимать больше sourceDailyCap слотов; за один проход
 * выбирается максимум dailyLeft постов. Кринж-квота жёстко резервируется:
 * мемы не могут занять кринжовые слоты, пока есть кринжовые кандидаты
 * (при их отсутствии мемы могут занять остаток). Возвращает выбранные id.
 */
export function pickByFairness(
  candidates: ReadonlyArray<SelectCandidate>,
  rules: QuotaRules,
  counters: DayCounters
): number[] {
  const remainingTotal = dailyLeft(rules, counters);
  if (remainingTotal === 0) return [];

  const remainingCringe = cringeQuotaLeft(rules, counters);
  const cringeEligible = candidates.filter((candidate) => isCringeCategory(candidate.category)).length;
  const memesLimit = cringeEligible > 0 ? remainingTotal - remainingCringe : remainingTotal;
  const sourceCap = new Map<string, number>();
  const perCategoryCount = { memes: 0, cringe: 0 };

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const picked: number[] = [];

  for (const candidate of sorted) {
    if (picked.length >= remainingTotal) break;

    const perSourceKey = String(candidate.sourceChatId);
    const usedSource = (counters.perSource[perSourceKey] ?? 0) + (sourceCap.get(perSourceKey) ?? 0);
    if (usedSource >= Math.max(1, rules.sourceDailyCap)) continue;

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
