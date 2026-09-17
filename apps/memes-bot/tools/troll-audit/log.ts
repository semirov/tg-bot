/**
 * Живые логи прогонов аудита.
 *
 * Задача — чтобы по ходу прогона в терминале было видно, что происходит:
 * какой кейс считается, что ответил бот, как это оценили ревизор и судья.
 * Кейсы разделяются делиметрами (hr), ответы бота и резолюции оценщиков
 * идут разными подписанными строками, а сырые JSON-ответы оценщиков в лог
 * не попадают — только их разобранная резолюция, которую печатает прогонщик.
 *
 * Переключатели:
 *   AUDIT_QUIET=1     — выключить живой вывод;
 *   AUDIT_VERBOSE=1   — печатать ещё промпты и сырые ответы оценщиков.
 */

import { TraceEvent, TraceStart, setTrace, setTraceStart } from './llm';

const STARTED_AT = Date.now();
const QUIET = process.env.AUDIT_QUIET === '1';
const VERBOSE = process.env.AUDIT_VERBOSE === '1';

/** Ширина делиметра — под обычный терминал. */
const WIDTH = 96;

/** Сколько прошло с начала прогона: «+01:23». */
export function elapsed(): string {
  const total = Math.floor((Date.now() - STARTED_AT) / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `+${minutes}:${seconds}`;
}

/** Схлопывает переносы в « ⏎ » и обрезает длинный текст. */
export function flat(text: string, limit = 0): string {
  const value = (text ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim();
  return limit > 0 && value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function prefix(tag: string): string {
  return tag ? `${elapsed()}  [${tag}] ` : `${elapsed()}  `;
}

/** Делиметр между кейсами: заголовок по центру линейки. */
export function hr(label = ''): void {
  if (QUIET) {
    return;
  }
  if (!label) {
    process.stdout.write(`${'─'.repeat(WIDTH)}\n`);
    return;
  }
  const head = ` ${label} `;
  const left = Math.max(0, Math.floor((WIDTH - head.length) / 2));
  const right = Math.max(0, WIDTH - head.length - left);
  process.stdout.write(`\n${'─'.repeat(left)}${head}${'─'.repeat(right)}\n`);
}

/** Одна подписанная строка: «бот: …», «pro: 0.9 — …» и т.п. */
export function say(tag: string, message: string): void {
  if (QUIET) {
    return;
  }
  process.stdout.write(`${prefix(tag)}${message}\n`);
}

/**
 * Текст под подписью: одной строкой, как и say, но с обрезкой и защитой
 * от пустого значения. Нужен для ответов бота и вариантов.
 */
export function show(tag: string, label: string, text: string, limit = 700): void {
  say(tag, `${label}: ${flat(text, limit) || '(пусто)'}`);
}

/** Список оценок оценщика одной строкой: «0.80 · 0.85» с подписью. */
export function sayScores(tag: string, label: string, entries: string[]): void {
  say(tag, `${label}: ${entries.join(' · ')}`);
}

/** Название модели без длинного имени провайдера — для коротких строк лога. */
function shortModel(model: string): string {
  return model.replace(/^deepseek-/, '');
}

/** Как часто напоминать, что ответа модели всё ещё нет. */
const HEARTBEAT_MS = 15000;

function callKey(event: { tag: string; label: string; model: string }): string {
  return `${event.tag}|${event.label}|${event.model}`;
}

/** Таймеры «всё ещё жду» — по одному на незавершённый запрос. */
const waiting = new Map<string, NodeJS.Timeout>();

/** Подключает живой вывод обращений к модели. */
export function attachTrace(): void {
  if (QUIET) {
    return;
  }

  // Начало запроса: чтобы ожидание не выглядело как зависание.
  setTraceStart((event: TraceStart) => {
    say(event.tag, `→ ${event.label}: запрос к ${shortModel(event.model)}, жду ответа`);
    const key = callKey(event);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      say(
        event.tag,
        `→ ${event.label}: всё ещё жду (${Math.round((Date.now() - startedAt) / 1000)}с)`
      );
    }, HEARTBEAT_MS);
    timer.unref?.();
    waiting.set(key, timer);
  });

  setTrace((event: TraceEvent) => {
    const key = callKey(event);
    const timer = waiting.get(key);
    if (timer) {
      clearInterval(timer);
      waiting.delete(key);
    }

    const tokens = `in ${event.promptTokens}/out ${event.completionTokens}${
      event.reasoningTokens ? `+reasoning ${event.reasoningTokens}` : ''
    }`;

    // Оценщик (ревизор, судья): в лог идёт только факт вызова — в verbose,
    // а саму резолюцию печатает прогонщик уже разобранной.
    if (event.kind === 'assess') {
      if (VERBOSE) {
        say(event.tag, `${event.label} ${shortModel(event.model)} ${(event.ms / 1000).toFixed(1)}с, ${tokens}`);
        show(event.tag, '  оценщик (сырой ответ)', event.content, 800);
      }
      return;
    }

    say(
      event.tag,
      `← ${event.label} — ${shortModel(event.model)} ${(event.ms / 1000).toFixed(1)}с, ${tokens}`
    );

    if (VERBOSE) {
      show(event.tag, '  запрос: system', event.system, 3000);
      show(event.tag, '  запрос: user', event.user, 6000);
    }

    show(event.tag, '  текст', event.content, 800);
  });
}
