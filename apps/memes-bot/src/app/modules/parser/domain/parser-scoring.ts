import {
  CRINGE_REACTIONS,
  EvalStage,
  NEGATIVE_REACTIONS,
  POSITIVE_REACTIONS,
} from '../constants/parser.constants';

/** Реакции одного поста (посчитанные счётчики). */
export interface ReactionCounts {
  total: number;
  positive: number;
  negative: number;
  cringe: number;
}

/** Базлайн канала по последним постам. */
export interface ChannelBaseline {
  vmed: number;
  rmed: number;
  p90: number;
  posShare: number;
  sampleSize: number;
  updatedAt?: string;
}

/** Нормированные метрики поста относительно базлайна канала. */
export interface PostMetrics {
  nv: number;
  nr: number;
  rr: number;
  posShare: number;
  cringeShare: number;
}

/** Правила отбора (значения по умолчанию — из настроек парсера). */
export interface SelectionRules {
  minViews: number;
  minReactions: number;
  nvMin: number;
  nrMin: number;
  posShareMin: number;
  hotScore: number;
}

/** Результат проверки порогов. */
export interface ThresholdVerdict {
  passed: boolean;
  reasons: string[];
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.max(0, sorted[Math.max(0, idx)]);
};

/** Медиана; для чётного количества — среднее двух центральных. */
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Считает базлайн канала по последним постам: медиана просмотров, медиана
 * реакций, p90 просмотров и доля положительных реакций.
 */
export function computeBaseline(
  posts: Array<{ views: number; reactions: number; posShare: number }>,
  now: Date = new Date()
): ChannelBaseline {
  const views = posts.map((p) => Math.max(0, p.views)).sort((a, b) => a - b);
  const reactions = posts.map((p) => Math.max(0, p.reactions)).sort((a, b) => a - b);
  const posShares = posts.map((p) => (Number.isFinite(p.posShare) ? p.posShare : 0));

  return {
    vmed: median(views),
    rmed: median(reactions),
    p90: percentile(views, 90),
    posShare: posShares.length ? posShares.reduce((s, v) => s + v, 0) / posShares.length : 0,
    sampleSize: posts.length,
    updatedAt: now.toISOString(),
  };
}

/** Считает агрегаты реакций по списку {emoji, count}. */
export function countReactions(
  results: ReadonlyArray<{ emoji: string; count: number }> | undefined
): ReactionCounts {
  let total = 0;
  let positive = 0;
  let negative = 0;
  let cringe = 0;
  for (const item of results ?? []) {
    const count = Math.max(0, Math.floor(item.count ?? 0));
    if (!count) continue;
    total += count;
    if (POSITIVE_REACTIONS.includes(item.emoji)) positive += count;
    if (NEGATIVE_REACTIONS.includes(item.emoji)) negative += count;
    if (CRINGE_REACTIONS.includes(item.emoji)) cringe += count;
  }
  return { total, positive, negative, cringe };
}

/** Метрики поста относительно базлайна. */
export function computePostMetrics(
  views: number,
  reactionCounts: ReactionCounts,
  baseline: ChannelBaseline
): PostMetrics {
  const vmed = Math.max(1, baseline.vmed);
  const rmed = Math.max(1, baseline.rmed);
  const v = Math.max(0, views ?? 0);

  return {
    nv: v / vmed,
    nr: reactionCounts.total / rmed,
    rr: reactionCounts.total / Math.max(1, v),
    posShare: reactionCounts.total > 0 ? reactionCounts.positive / reactionCounts.total : 0,
    cringeShare: reactionCounts.total > 0 ? reactionCounts.cringe / reactionCounts.total : 0,
  };
}

/** Итоговый скор поста: сумма нормированных соотношений. */
export function computeScore(metrics: PostMetrics): number {
  return metrics.nv + metrics.nr;
}

/**
 * Проверка порогов для memes-категории: абсолютный пол (просмотры и реакции),
 * затем относительное превосходство (nv, nr или близость к p90) и доля
 * положительных реакций не провалена.
 */
export function passesThresholds(
  views: number,
  metrics: PostMetrics,
  rules: SelectionRules,
  baseline: ChannelBaseline
): ThresholdVerdict {
  const reasons: string[] = [];
  if ((views ?? 0) < rules.minViews) reasons.push(`views<${rules.minViews}`);
  if ((metrics.nr * Math.max(1, baseline.rmed)) < rules.minReactions) {
    reasons.push(`reactions<${rules.minReactions}`);
  }
  const atP90 = baseline.p90 > 0 && (views ?? 0) >= baseline.p90 * 0.9;
  const relative = metrics.nv >= rules.nvMin || metrics.nr >= rules.nrMin || atP90;
  if (!relative) reasons.push(`nv<${rules.nvMin},nr<${rules.nrMin},views<p90`);
  if (metrics.posShare < rules.posShareMin) reasons.push(`posShare<${rules.posShareMin}`);

  return { passed: reasons.length === 0, reasons };
}

/**
 * Проверка «кринжовости»: заметная доля 🤡/💩 и абсолютный пол по просмотрам
 * (кринжовые каналы обычно меньше мемных).
 */
export function passesCringe(
  views: number,
  metrics: PostMetrics,
  minViews: number,
  cringeShareMin: number
): ThresholdVerdict {
  const reasons: string[] = [];
  if ((views ?? 0) < minViews) reasons.push(`views<${minViews}`);
  if (metrics.cringeShare < cringeShareMin) reasons.push(`cringeShare<${cringeShareMin}`);
  return { passed: reasons.length === 0, reasons };
}

/** Ранний выход: скор достаточен до финальной оценки. */
export function isHotEnough(metrics: PostMetrics, rules: SelectionRules): boolean {
  return computeScore(metrics) >= rules.hotScore;
}

/** Стадия оценки по возрасту кандидата (null — ещё рано). */
export function stageForAge(ageMs: number, preHours: number, finalHours: number): EvalStage | null {
  const hours = ageMs / 3_600_000;
  if (hours >= finalHours) return EvalStage.FINAL;
  return hours >= preHours ? EvalStage.PRE : null;
}

/** «12.3K»/«1,2M» → число просмотров (как в web-preview t.me/s/). */
export function parseViewCount(raw: string | undefined | null): number {
  if (!raw) return 0;
  const match = raw.trim().replace(/,/g, '.').match(/^([\d.]+)\s*([KkMm]?)$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier = { '': 1, k: 1_000, m: 1_000_000 }[match[2].toLowerCase()];
  return Math.round(value * multiplier);
}

/** Формат просмотров для карточки: 12345 → «12.3K». */
export function formatViews(views: number): string {
  const v = Math.max(0, views ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${v}`;
}
