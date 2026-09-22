import {
  TROLL_MEMBER_BIO_CANARY,
  TROLL_MEMBER_BIO_CORE_MIN,
  TROLL_MEMBER_BIO_DROP_THRESHOLD,
  TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS,
  TROLL_MEMBER_BIO_HALF_LIFE_MAX_HOURS,
  TROLL_MEMBER_BIO_LEAK_NGRAM,
  TROLL_MEMBER_BIO_MAX_FACTS,
  TROLL_MEMBER_BIO_SIMILARITY,
  TROLL_MEMBER_BIO_WEIGHT_BOOST,
  TROLL_MEMBER_BIO_WEIGHT_INITIAL,
  TROLL_MEMBER_BIO_WEIGHT_MAX,
} from '../constants/troll-limits';
import { TrollMemberBioFact } from '../entities/troll-member-bio.entity';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Обезвреживает текст, попадающий в блок памяти: убирает угловые скобки
 * (защита от breakout из `<memory>`), canary, управляющие символы; сводит
 * к одной строке и ограничивает длину.
 */
export function sanitizeMemoryText(text: string, maxChars = 120): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .split(TROLL_MEMBER_BIO_CANARY).join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** Нормализует текст факта для сравнения: нижний регистр, ё→е, без пунктуации. */
export function normalizeFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Слова факта длиной ≥3 символа. */
export function factTokens(text: string): string[] {
  return normalizeFact(text)
    .split(' ')
    .filter((token) => token.length >= 3);
}

/** Похожесть двух фактов: доля совпавших слов (с учётом префиксов), 0..1. */
export function factSimilarity(a: string, b: string): number {
  const left = new Set(factTokens(a));
  const right = new Set(factTokens(b));
  if (left.size < 2 || right.size < 2) {
    return 0;
  }
  let matched = 0;
  for (const token of left) {
    for (const other of right) {
      if (
        token === other ||
        (token.length >= 4 && other.length >= 4 && (token.startsWith(other) || other.startsWith(token)))
      ) {
        matched += 1;
        break;
      }
    }
  }
  return matched / Math.min(left.size, right.size);
}

/**
 * Детерминированный отсев персональных данных (страховка поверх промпта).
 * Режем ЗНАЧЕНИЯ: даты рождения, госномера, телефоны, документы с номерами,
 * адреса с домом/квартирой.
 */
export function looksLikePii(text: string): boolean {
  const patterns = [
    /\d{2}[.\-/]\d{2}[.\-/]\d{4}/, // дата рождения
    /(?<![A-Za-zА-Яа-я0-9])[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}(?![A-Za-zА-Яа-я0-9])/i, // госномер РФ
    /(\+7|\b8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/, // телефон
    /(?:паспорт|снилс|(?:^|[^а-яёa-z0-9])инн)\w*[^\n]{0,25}\d/i, // документ с номером
    /\d{3}-\d{3}-\d{3}\s*\d{2}/, // СНИЛС
    /(ул\.|улиц\w+|проспект\w*|переул\w+|шоссе|д\.\s*\d|дом\s*\d|кв\.\s*\d|квартир\w*\s*№?\s*\d)/i,
    /(адрес|проживан\w*|пропис\w*)[^\n]{0,30}\d/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/** Период полураспада факта, часы: база × важность × бонус за подтверждения. */
export function halfLifeHours(fact: Pick<TrollMemberBioFact, 'importance' | 'count'>): number {
  const importance = Math.max(1, Math.min(5, Math.round(fact.importance) || 1));
  const confirmations = Math.max(1, fact.count);
  const hours = TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS * importance * (1 + 0.5 * (confirmations - 1));
  return Math.max(TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS, Math.min(TROLL_MEMBER_BIO_HALF_LIFE_MAX_HOURS, hours));
}

/** Текущий вес факта: baseWeight, распавшийся за время с последнего подтверждения. */
export function decayedWeight(fact: TrollMemberBioFact, nowMs: number): number {
  const elapsedHours = Math.max(0, nowMs - fact.lastSeenAt) / HOUR_MS;
  return fact.baseWeight * 0.5 ** (elapsedHours / halfLifeHours(fact));
}

export interface ExtractedFact {
  text: string;
  importance: number;
}

export interface MergeResult {
  facts: TrollMemberBioFact[];
  added: number;
  promoted: number;
  dropped: number;
}

/**
 * Сливает новые факты с текущим досье: похожие подтверждаются (растёт счётчик
 * и вес), новые добавляются. Затем применяет распад по времени и вымывает
 * факты с весом ниже порога.
 */
export function mergeFacts(
  existing: TrollMemberBioFact[],
  extracted: ExtractedFact[],
  nowMs: number
): MergeResult {
  const facts: TrollMemberBioFact[] = existing.map((fact) => ({ ...fact }));
  let added = 0;
  let promoted = 0;
  let processed = 0;

  for (const candidate of extracted) {
    if (processed >= TROLL_MEMBER_BIO_MAX_FACTS) {
      break;
    }
    const text = sanitizeMemoryText(candidate.text);
    if (!text || text.length < 3 || looksLikePii(text)) {
      continue;
    }
    let best: TrollMemberBioFact | null = null;
    let bestScore = 0;
    for (const fact of facts) {
      const score = factSimilarity(text, fact.text);
      if (score > bestScore) {
        bestScore = score;
        best = fact;
      }
    }
    if (best && bestScore >= TROLL_MEMBER_BIO_SIMILARITY) {
      const wasCore = best.count >= TROLL_MEMBER_BIO_CORE_MIN;
      best.count += 1;
      best.baseWeight = Math.min(TROLL_MEMBER_BIO_WEIGHT_MAX, best.baseWeight + TROLL_MEMBER_BIO_WEIGHT_BOOST);
      best.lastSeenAt = nowMs;
      best.importance = Math.max(best.importance, Math.min(5, Math.max(1, Math.round(candidate.importance) || 1)));
      if (!wasCore && best.count >= TROLL_MEMBER_BIO_CORE_MIN) {
        promoted += 1;
      }
    } else {
      facts.push({
        text,
        importance: Math.min(5, Math.max(1, Math.round(candidate.importance) || 1)),
        count: 1,
        firstSeenAt: nowMs,
        lastSeenAt: nowMs,
        baseWeight: TROLL_MEMBER_BIO_WEIGHT_INITIAL,
        weight: TROLL_MEMBER_BIO_WEIGHT_INITIAL,
      });
      added += 1;
    }
    processed += 1;
  }

  let dropped = 0;
  for (const fact of facts) {
    fact.weight = decayedWeight(fact, nowMs);
  }
  const alive = facts.filter((fact) => fact.weight >= TROLL_MEMBER_BIO_DROP_THRESHOLD);
  dropped = facts.length - alive.length;
  alive.sort((a, b) => b.count - a.count || b.weight - a.weight);
  return { facts: alive, added, promoted, dropped };
}

/** Применяет распад к досье без новых фактов (для крона). */
export function decayOnly(existing: TrollMemberBioFact[], nowMs: number): { facts: TrollMemberBioFact[]; dropped: number } {
  const facts = existing.map((fact) => ({ ...fact, weight: decayedWeight(fact, nowMs) }));
  const alive = facts.filter((fact) => fact.weight >= TROLL_MEMBER_BIO_DROP_THRESHOLD);
  alive.sort((a, b) => b.count - a.count || b.weight - a.weight);
  return { facts: alive, dropped: facts.length - alive.length };
}

/** Рендерит досье текстом: только «живые» факты, в потолок символов (стабильные — первыми). */
export function renderBioText(facts: TrollMemberBioFact[], maxChars: number, nowMs = Date.now()): string {
  const lines: string[] = [];
  let used = 0;
  for (const fact of facts) {
    if (decayedWeight(fact, nowMs) < TROLL_MEMBER_BIO_DROP_THRESHOLD) {
      continue;
    }
    const text = sanitizeMemoryText(fact.text);
    if (!text) {
      continue;
    }
    const line = `- ${text}`;
    if (used + line.length + 1 > maxChars) {
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * true, если ответ раскрывает внутренние данные: содержит canary или дословно
 * повторяет фрагмент факта длиной ≥ TROLL_MEMBER_BIO_LEAK_NGRAM слов.
 */
export function findBioLeak(answer: string, factTexts: string[], canary: string): boolean {
  const lowered = answer.toLowerCase();
  if (canary && lowered.includes(canary.toLowerCase())) {
    return true;
  }
  const answerWords = normalizeFact(answer).split(' ').filter(Boolean);
  for (const fact of factTexts) {
    const factText = normalizeFact(fact);
    if (!factText) {
      continue;
    }
    for (let start = 0; start + TROLL_MEMBER_BIO_LEAK_NGRAM <= answerWords.length; start += 1) {
      const gram = answerWords.slice(start, start + TROLL_MEMBER_BIO_LEAK_NGRAM).join(' ');
      if (factText.includes(gram)) {
        return true;
      }
    }
  }
  return false;
}
