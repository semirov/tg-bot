/**
 * Тарифы DeepSeek для учёта суточного расхода в деньгах.
 *
 * Источник: https://api-docs.deepseek.com/quick_start/pricing
 * Цены — в долларах за 1M токенов. Off-peak тариф ровно вдвое дешевле пикового.
 *
 * Пиковые часы: 01:00–04:00 и 06:00–10:00 UTC, с понедельника по пятницу.
 * Всё остальное время — off-peak.
 *
 * Если DeepSeek меняет цены, обновите таблицу или задайте свои значения через
 * env DEEPSEEK_PRICE_CACHE_HIT / DEEPSEEK_PRICE_CACHE_MISS / DEEPSEEK_PRICE_OUTPUT.
 */

export interface DeepSeekTariff {
  /** Входные токены, попавшие в кэш промпта, $ за 1M. */
  cacheHitInput: number;
  /** Входные токены мимо кэша, $ за 1M. */
  cacheMissInput: number;
  /** Выходные токены (включая reasoning), $ за 1M. */
  output: number;
}

export interface DeepSeekModelTariff {
  peak: DeepSeekTariff;
  offPeak: DeepSeekTariff;
}

export const DEEPSEEK_TARIFFS: Record<string, DeepSeekModelTariff> = {
  'deepseek-flash': {
    peak: { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 },
    offPeak: { cacheHitInput: 0.003, cacheMissInput: 0.15, output: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
    offPeak: { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 },
  },
};

/** Тариф по умолчанию, если модель неизвестна (берём flash как основную). */
export const DEEPSEEK_DEFAULT_TARIFF: DeepSeekModelTariff = DEEPSEEK_TARIFFS['deepseek-flash'];

/** Идёт ли сейчас пиковый тариф (Пн–Пт, 01:00–04:00 и 06:00–10:00 UTC). */
export function isDeepSeekPeak(date: Date = new Date()): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) {
    return false;
  }
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** Токены одного ответа, как их отдаёт DeepSeek в `usage`. */
export interface DeepSeekTokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Попали ли входные токены в кэш (иначе считаем по цене мимо кэша). */
  cacheHitTokens: number;
  cacheMissTokens: number;
}

/** Стоимость одного запроса в долларах. */
export function estimateCostUsd(
  model: string,
  usage: DeepSeekTokenUsage,
  options: { date?: Date; tariff?: DeepSeekTariff } = {}
): number {
  const modelTariff = DEEPSEEK_TARIFFS[model] ?? DEEPSEEK_DEFAULT_TARIFF;
  const tariff =
    options.tariff ?? (isDeepSeekPeak(options.date ?? new Date()) ? modelTariff.peak : modelTariff.offPeak);

  // Если разбивки по кэшу нет, все входные токены считаем как промах (дороже).
  const cacheHit = usage.cacheHitTokens;
  const cacheMiss = usage.cacheMissTokens || Math.max(0, usage.promptTokens - cacheHit);

  return (
    (cacheHit * tariff.cacheHitInput +
      cacheMiss * tariff.cacheMissInput +
      usage.completionTokens * tariff.output) /
    1_000_000
  );
}

/** Человекочитаемая сумма: мелкие траты показываем в центах с четырьмя знаками. */
export function formatUsd(amount: number): string {
  if (amount >= 1) {
    return `$${amount.toFixed(2)}`;
  }
  if (amount >= 0.0001) {
    return `$${amount.toFixed(4)}`;
  }
  return amount > 0 ? '< $0.0001' : '$0';
}
