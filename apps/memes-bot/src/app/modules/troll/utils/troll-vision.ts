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
    return collapsed ? collapsed.slice(0, maxChars) : null;
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

  const result = parts.join('; ').trim();
  return result ? result.slice(0, maxChars) : null;
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
