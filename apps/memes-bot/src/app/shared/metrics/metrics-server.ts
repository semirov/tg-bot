import { timingSafeEqual } from 'crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'http';

import { renderMetrics } from './render';

/** Конфигурация HTTP-сервера метрик. */
export interface MetricsServerConfig {
  port: number;
  host: string;
  /** Если задан — требуется заголовок `Authorization: Bearer <token>`. */
  token?: string;
}

const DEFAULT_PORT = 9464;
const DEFAULT_HOST = '0.0.0.0';

/** Включён ли экспорт метрик (по умолчанию да). */
export function isMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.METRICS_ENABLED;
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return true;
  }
  return `${raw}`.toLowerCase() !== 'false';
}

/** Собирает конфигурацию сервера из переменных окружения с безопасными дефолтами. */
export function metricsServerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MetricsServerConfig {
  const rawPort = Number(env.METRICS_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT;
  const host = env.METRICS_HOST?.trim() || DEFAULT_HOST;
  const token = env.METRICS_TOKEN?.trim() || undefined;
  return { port, host, token };
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

/**
 * Возвращает обработчик HTTP для `/metrics`. Вынесен отдельно, чтобы
 * тестировать контракт (метод, путь, авторизация, ошибки) без открытия порта.
 */
export function createMetricsRequestHandler(
  token?: string
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    if (token && !tokenMatches(token, bearerToken(req))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unauthorized');
      return;
    }

    renderMetrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      })
      .catch((error) => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`metrics error: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}

/** Запускает отдельный HTTP-сервер метрик. Порт слушается только внутри контейнера. */
export function startMetricsServer(config: MetricsServerConfig): Server {
  const server = createServer(createMetricsRequestHandler(config.token));
  server.listen(config.port, config.host);
  return server;
}

/**
 * Точка входа для bootstrap: поднимает сервер, если экспорт не отключён.
 * Ошибки запуска не должны ронять бота — логируем и продолжаем.
 */
export function startMetricsServerFromEnv(env: NodeJS.ProcessEnv = process.env): Server | undefined {
  if (!isMetricsEnabled(env)) {
    return undefined;
  }
  const config = metricsServerConfigFromEnv(env);
  const server = startMetricsServer(config);
  server.on('error', (error) => {
    // Логгер здесь недоступен (bootstrap), поэтому console — осознанно.
    // eslint-disable-next-line no-console
    console.error(`Metrics server error on ${config.host}:${config.port}:`, error);
  });
  return server;
}
