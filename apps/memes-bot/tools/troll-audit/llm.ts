/**
 * Тонкий клиент DeepSeek для оффлайн-аудита промптов.
 *
 * Генерация идёт на рабочей модели (deepseek-flash), оценка — на старшей
 * (deepseek-v4-pro), чтобы качество судила более сильная модель.
 */

import axios, { AxiosInstance } from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';

export const GEN_MODEL = process.env.AUDIT_GEN_MODEL || 'deepseek-flash';
export const JUDGE_MODEL = process.env.AUDIT_JUDGE_MODEL || 'deepseek-v4-pro';

/** Уровень «размышлений»: none | minimal | low | medium | high | xhigh | max. */
export const GEN_EFFORT = process.env.AUDIT_GEN_EFFORT ?? 'none';
export const JUDGE_EFFORT = process.env.AUDIT_JUDGE_EFFORT ?? 'low';

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  throw new Error(
    'Не задан DEEPSEEK_API_KEY. Секретов в файлах нет: запускай прогон как\n' +
      "  DEEPSEEK_API_KEY=... npx ts-node --transpile-only -O '{\"module\":\"commonjs\"}' troll-audit/run.ts"
  );
}

const client: AxiosInstance = axios.create({
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  timeout: 180000,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
});

export interface CallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  /** null — не передавать параметр вовсе. */
  reasoningEffort?: string | null;
  /**
   * generate — генерация ответа в чат (текст показываем в логе),
   * assess — оценка ревизора/судьи (в логе только факт вызова).
   */
  kind?: 'generate' | 'assess';
  /** Подпись вызова для лога: «бот», «контроль», «попытка 2». */
  label?: string;
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  emptyAnswers: number;
  retries: number;
}

/** Событие одного обращения к модели — для живого лога прогона. */
export interface TraceEvent {
  /** Метка кейса из withTag(): по ней строки лога не перемешиваются. */
  tag: string;
  kind: 'generate' | 'assess';
  /** Подпись вызова: «бот», «контроль», «попытка 2», «оценщик». */
  label: string;
  model: string;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Пустой ответ — отдельный случай: его тоже надо видеть в логе. */
  empty: boolean;
  content: string;
  system: string;
  user: string;
}

/** Событие «запрос ушёл в модель» — чтобы в логе было видно ожидание, а не тишина. */
export interface TraceStart {
  tag: string;
  kind: 'generate' | 'assess';
  label: string;
  model: string;
}

let traceHandler: ((event: TraceEvent) => void) | null = null;
let traceStartHandler: ((event: TraceStart) => void) | null = null;

/** Подключает живой вывод обращений к модели (см. log.ts). */
export function setTrace(handler: ((event: TraceEvent) => void) | null): void {
  traceHandler = handler;
}

/** Подключает живой вывод начала запроса — чтобы было видно ожидание. */
export function setTraceStart(handler: ((event: TraceStart) => void) | null): void {
  traceStartHandler = handler;
}

const tagStore = new AsyncLocalStorage<{ tag: string }>();

/**
 * Помечает всю асинхронную работу меткой кейса. Прогонять кейсы надо через
 * неё: при параллельном пуле иначе не понять, чьи строки в логе.
 */
export function withTag<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  return tagStore.run({ tag }, fn);
}

export const usage: Usage = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  emptyAnswers: 0,
  retries: 0,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Один вызов chat/completions с повторами на сетевых сбоях DeepSeek. */
export async function call(
  messages: Array<{ role: string; content: string }>,
  options: CallOptions = {}
): Promise<string> {
  const {
    model = GEN_MODEL,
    temperature = 1.05,
    json = false,
    reasoningEffort = GEN_EFFORT,
    kind = 'generate',
  } = options;
  let maxTokens = options.maxTokens ?? 700;

  let lastError: unknown;
  let budgetGrow = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = Date.now();
    traceStartHandler?.({
      tag: tagStore.getStore()?.tag ?? '',
      kind,
      label: options.label ?? (kind === 'assess' ? 'оценщик' : 'бот'),
      model,
    });
    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (json) {
        body.response_format = { type: 'json_object' };
      }
      if (reasoningEffort) {
        body.reasoning_effort = reasoningEffort;
      }

      const response = await client.post('/chat/completions', body);
      const data = response.data;
      const promptTokens: number = data?.usage?.prompt_tokens ?? 0;
      const completionTokens: number = data?.usage?.completion_tokens ?? 0;
      const reasoningTokens: number = data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      usage.calls += 1;
      usage.promptTokens += promptTokens;
      usage.completionTokens += completionTokens;
      usage.reasoningTokens += reasoningTokens;

      const content: string = data?.choices?.[0]?.message?.content?.trim() ?? '';
      const finishReason = data?.choices?.[0]?.finish_reason;

      traceHandler?.({
        tag: tagStore.getStore()?.tag ?? '',
        kind,
        label: options.label ?? (kind === 'assess' ? 'оценщик' : 'бот'),
        model,
        ms: Date.now() - startedAt,
        promptTokens,
        completionTokens,
        reasoningTokens,
        empty: !content,
        content,
        system: messages.find((message) => message.role === 'system')?.content ?? '',
        user: messages
          .filter((message) => message.role !== 'system')
          .map((message) => message.content)
          .join('\n'),
      });

      if (!content) {
        usage.emptyAnswers += 1;
        process.stderr.write(
          `  · пустой ответ (model=${model}, finish=${finishReason}, reasoning_tokens=${reasoningTokens}, max_tokens=${maxTokens})\n`
        );
        // Reasoning-модель может съесть весь бюджет на размышления: даём вдвое больше.
        if (finishReason === 'length' && budgetGrow < 2) {
          budgetGrow += 1;
          maxTokens *= 2;
          continue;
        }
      }
      return content;
    } catch (error) {
      lastError = error;
      usage.retries += 1;
      const detail = axios.isAxiosError(error)
        ? `${error.message}${error.response ? ` (status ${error.response.status})` : ''}`
        : String(error);
      process.stderr.write(`  · ретрай запроса: ${detail}\n`);
      await sleep(2500);
    }
  }

  throw lastError;
}

/** Пытается вытащить JSON-объект из ответа модели. */
export function parseJson<T>(raw: string): T | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

/** Простой пул параллельных задач с ограничением. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
