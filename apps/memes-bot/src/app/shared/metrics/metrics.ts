import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import { APP_VERSION } from '../../version';

/**
 * Реестр метрик Prometheus для всего приложения.
 *
 * Это module-level singleton (а не Nest-провайдер) сознательно: метрики —
 * инфраструктурный side-effect, а не бизнес-зависимость. Так их можно
 * инкрементировать из любого сервиса без правки конструкторов и без
 * переписывания десятков юнит-спеков. Читает реестр отдельный HTTP-сервер
 * (`metrics-server.ts`), а бизнес-гейджи из БД наполняет
 * `MetricsCollectorService`.
 */
export const registry = new Registry();

registry.setDefaultLabels({ app: 'memes-bot' });

let defaultMetricsStarted = false;

/**
 * Включает сбор стандартных метрик процесса (CPU, память, event loop, GC,
 * handles) и проставляет `memes_bot_info`. Идемпотентно.
 *
 * Не вызывается при импорте: таймеры `collectDefaultMetrics` не должны
 * подниматься в юнит-тестах. Запускается один раз из bootstrap (`main.ts`).
 */
export function initMetrics(): void {
  if (defaultMetricsStarted) {
    return;
  }
  defaultMetricsStarted = true;
  collectDefaultMetrics({ register: registry });
  metrics.info.set({ version: APP_VERSION, node: process.version }, 1);
}

function counter(name: string, help: string, labelNames: string[]): Counter<string> {
  return new Counter({ name: `memes_bot_${name}`, help, labelNames, registers: [registry] });
}

function gauge(name: string, help: string, labelNames: string[]): Gauge<string> {
  return new Gauge({ name: `memes_bot_${name}`, help, labelNames, registers: [registry] });
}

function histogram(
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[]
): Histogram<string> {
  return new Histogram({
    name: `memes_bot_${name}`,
    help,
    labelNames,
    registers: [registry],
    buckets,
  });
}

const API_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const LLM_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 40, 80];
const JOB_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300];

export const metrics = {
  info: gauge('info', 'Информация о сборке бота (всегда 1).', ['version', 'node']),

  updates: {
    total: counter('updates_total', 'Обработанные обновления Telegram по типу.', ['type']),
    errors: counter('update_errors_total', 'Ошибки при обработке обновлений.', ['type']),
  },

  telegramApi: {
    requests: counter('telegram_api_requests_total', 'Вызовы Telegram Bot API по методам.', [
      'method',
      'result',
    ]),
    duration: histogram(
      'telegram_api_request_duration_seconds',
      'Длительность вызовов Telegram Bot API, сек.',
      ['method'],
      API_BUCKETS
    ),
  },

  llm: {
    requests: counter('llm_requests_total', 'Запросы к LLM по модели и метке.', [
      'model',
      'label',
      'result',
    ]),
    duration: histogram(
      'llm_request_duration_seconds',
      'Длительность запросов к LLM, сек.',
      ['model', 'label'],
      LLM_BUCKETS
    ),
    tokens: counter('llm_tokens_total', 'Токены LLM по типу (prompt/completion/cache).', [
      'model',
      'type',
    ]),
    costUsd: counter('llm_cost_usd_total', 'Оценка стоимости запросов LLM, USD.', ['model']),
    activeRequests: gauge('llm_active_requests', 'Запросы к LLM в полёте.', []),
    limitHits: counter('llm_limit_hits_total', 'Срабатывания лимитов LLM.', ['reason']),
    dailyRequests: gauge('llm_daily_requests', 'Запросы к LLM за текущие сутки (UTC).', []),
    dailyTokens: gauge('llm_daily_tokens', 'Токены LLM за текущие сутки (UTC).', []),
    dailyCostUsd: gauge('llm_daily_cost_usd', 'Стоимость LLM за текущие сутки (UTC), USD.', []),
    dailyLimit: gauge('llm_daily_limit', 'Суточный лимит запросов к LLM (0 = без лимита).', []),
  },

  mtproto: {
    connected: gauge('mtproto_connected', 'Юзербот (MTProto) подключён (1) или нет (0).', []),
    channelMessages: counter(
      'mtproto_channel_messages_total',
      'Медиасообщения каналов, увиденные юзерботом.',
      []
    ),
    forwarded: counter('mtproto_forwarded_total', 'Форварды постов в бота.', ['result']),
    errors: counter('mtproto_errors_total', 'Ошибки операций юзербота.', ['operation']),
  },

  parser: {
    collected: counter('parser_candidates_collected_total', 'Собранные кандидаты по источникам.', [
      'source',
      'kind',
    ]),
    skipped: counter('parser_candidates_skipped_total', 'Пропущенные кандидаты.', [
      'source',
      'reason',
    ]),
    evaluated: counter('parser_candidates_evaluated_total', 'Оценённые кандидаты по решению.', [
      'decision',
    ]),
    delivered: counter('parser_candidates_delivered_total', 'Кандидаты, доставленные в предложку.', [
      'source',
      'category',
    ]),
    deliveryFailures: counter('parser_delivery_failures_total', 'Неудачные доставки кандидатов.', [
      'reason',
    ]),
    albums: counter('parser_albums_total', 'Обработанные медиагруппы (альбомы).', ['source']),
    jobDuration: histogram(
      'parser_job_duration_seconds',
      'Длительность cron-задач парсера, сек.',
      ['job'],
      JOB_BUCKETS
    ),
    jobRuns: counter('parser_job_runs_total', 'Запуски cron-задач парсера.', ['job', 'result']),
    jobLastSuccess: gauge(
      'parser_job_last_success_timestamp_seconds',
      'Unix-время последнего успешного запуска задачи парсера.',
      ['job']
    ),
    sourcesByStatus: gauge(
      'parser_sources_by_status',
      'Источники парсера по статусам (из БД).',
      ['status']
    ),
    candidatesByStatus: gauge(
      'parser_candidates_by_status',
      'Кандидаты парсера по статусам (из БД).',
      ['status']
    ),
  },

  observatory: {
    received: counter('observatory_posts_received_total', 'Посты, принятые обсерваторией.', []),
    deduplicated: counter(
      'observatory_posts_deduplicated_total',
      'Посты обсерватории, отброшенные как дубликаты.',
      []
    ),
    published: counter('observatory_posts_published_total', 'Опубликованные посты.', ['mode']),
    rejected: counter('observatory_posts_rejected_total', 'Отклонённые посты.', []),
    pending: gauge('observatory_posts_pending', 'Посты предложки в ожидании решения (из БД).', []),
    scheduledPending: gauge(
      'scheduled_posts_pending',
      'Запланированные, но ещё не опубликованные посты (из БД).',
      []
    ),
  },

  users: {
    total: gauge('users_total', 'Пользователи бота (из БД).', []),
  },
};

/**
 * prom-client принимает `collect` только в конструкторе и не объявляет его в
 * типе экземпляра, поэтому регистрируем сборщик через этот хелпер.
 */
export function setGaugeCollector(
  gauge: Gauge<string>,
  collect: () => void | Promise<void>
): void {
  (gauge as Gauge<string> & { collect?: () => void | Promise<void> }).collect = collect;
}

/**
 * Человекочитаемая метка источника без кардинального взрыва: username, иначе
 * название, иначе id канала. В метках не бывает секретов и message id.
 */
export function sourceLabel(source: {
  username?: string | null;
  title?: string | null;
  chatId?: string | number | null;
}): string {
  const username = source.username?.trim();
  if (username) {
    return `@${username.replace(/^@/, '')}`;
  }
  const title = source.title?.trim();
  if (title) {
    return title;
  }
  return source.chatId != null ? String(source.chatId) : 'unknown';
}
