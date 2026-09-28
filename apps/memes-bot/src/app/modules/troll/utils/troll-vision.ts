/**
 * Разбор ответа vision-модели в строку для истории диалога.
 *
 * Vision-модель возвращает строгий JSON с максимумом фактов (категория,
 * классификация, объекты, люди, текст с картинки, детали). В историю нельзя
 * класть многострочный JSON: расшифровка для модели — по строке на реплику.
 * Поэтому описание сворачивается в одну компактную строку с метками.
 */

import { TROLL_VISION_MAX_CHARS } from '../constants/troll-limits';
import { parseLlmJson } from './llm-json';

/** Маркер обрезки: показывает модели и человеку, что описание усечено. */
const TRUNCATION_MARKER = '…';

/** Ожидаемые поля ответа vision-модели (значения могут быть любого типа). */
export interface ImageAnalysis {
  category?: unknown;
  subtype?: unknown;
  summary?: unknown;
  scene?: unknown;
  objects?: unknown;
  people?: unknown;
  actions?: unknown;
  text?: unknown;
  style?: unknown;
  mood?: unknown;
  meme_template?: unknown;
  meme_reference?: unknown;
  joke_mechanism?: unknown;
  true_meaning?: unknown;
  punchline?: unknown;
  confidence?: unknown;
  details?: unknown;
  possible_meaning?: unknown;
  uncertain?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asList(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .join(', ');
}

function push(parts: string[], label: string, value: string): void {
  if (value) {
    parts.push(`${label}: ${value}`);
  }
}

/**
 * Обрезает строку до потолка, не разрывая последнее слово по середине:
 * режем по последнему пробелу в доступном бюджете и добавляем маркер.
 */
function truncateOnWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 0) {
    return '';
  }
  const budget = maxChars - TRUNCATION_MARKER.length;
  const clipped = text.slice(0, budget);
  const lastSpace = clipped.lastIndexOf(' ');
  const head = lastSpace > 0 ? clipped.slice(0, lastSpace).trimEnd() : clipped;
  return `${head}${TRUNCATION_MARKER}`;
}

/**
 * Обрезает набор полей по потолку, отбрасывая целиком те, что не влезли:
 * так в историю не попадает оборванное на середине поле.
 */
function truncateFields(parts: string[], maxChars: number): string {
  const full = parts.join('; ');
  if (full.length <= maxChars) {
    return full;
  }
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  let acc = '';
  for (const part of parts) {
    const candidate = acc ? `${acc}; ${part}` : part;
    if (candidate.length > budget) {
      break;
    }
    acc = candidate;
  }
  if (acc) {
    return `${acc}${TRUNCATION_MARKER}`;
  }
  return truncateOnWordBoundary(full, maxChars);
}

/**
 * Сворачивает JSON-описание изображения в одну строку.
 *
 * Если ответ не JSON — возвращается он же, сжатый в одну строку. Пустой
 * результат означает, что описания нет и класть в историю нечего.
 */
export function renderImageDescription(
  raw: string | null | undefined,
  maxChars = TROLL_VISION_MAX_CHARS
): string | null {
  if (!raw) {
    return null;
  }

  const parsed = parseLlmJson<ImageAnalysis>(raw);
  if (!parsed) {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (!collapsed) {
      return null;
    }
    return truncateOnWordBoundary(collapsed, maxChars) || null;
  }

  const parts: string[] = [];
  const type = [asString(parsed.category), asString(parsed.subtype)].filter(Boolean).join(' / ');
  push(parts, 'тип', type);
  push(parts, 'что', asString(parsed.summary));
  push(parts, 'обстановка', asString(parsed.scene));
  push(parts, 'объекты', asList(parsed.objects));
  push(parts, 'люди', asList(parsed.people));
  push(parts, 'действия', asList(parsed.actions));
  push(parts, 'текст', asString(parsed.text));
  push(parts, 'стиль', asString(parsed.style));
  push(parts, 'настроение', asString(parsed.mood));
  push(parts, 'мем-шаблон', asString(parsed.meme_template));
  push(parts, 'отсылка', asString(parsed.meme_reference));
  push(parts, 'механика шутки', asString(parsed.joke_mechanism));
  push(parts, 'истинный смысл', asString(parsed.true_meaning));
  push(parts, 'панчлайн', asString(parsed.punchline));
  push(parts, 'детали', asList(parsed.details));
  push(parts, 'смысл', asString(parsed.possible_meaning));
  push(parts, 'неясно', asList(parsed.uncertain));

  const result = truncateFields(parts, maxChars).trim();
  return result || null;
}

/**
 * Достаёт уверенность vision-модели (0..1) из её JSON-ответа. Не-JSON,
 * отсутствие поля или мусор дают 0 — тогда бот не комментирует картинку.
 */
export function readImageConfidence(raw: string | null | undefined): number {
  if (!raw) {
    return 0;
  }
  const parsed = parseLlmJson<ImageAnalysis>(raw);
  const value = Number(parsed?.confidence);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
