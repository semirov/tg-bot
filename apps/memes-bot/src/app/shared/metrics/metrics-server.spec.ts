import { request } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'http';

import * as renderModule from './render';
import {
  createMetricsRequestHandler,
  isMetricsEnabled,
  metricsServerConfigFromEnv,
  startMetricsServer,
  startMetricsServerFromEnv,
} from './metrics-server';

interface HttpResult {
  status: number;
  body: string;
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('metrics server', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    while (servers.length) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const listen = (token?: string): Promise<number> => {
    const server = startMetricsServer({ port: 0, host: '127.0.0.1', token });
    servers.push(server);
    return new Promise((resolve) => {
      server.on('listening', () => resolve((server.address() as AddressInfo).port));
    });
  };

  it('isMetricsEnabled: по умолчанию да, false отключает', () => {
    expect(isMetricsEnabled()).toBe(true);
    expect(isMetricsEnabled({})).toBe(true);
    expect(isMetricsEnabled({ METRICS_ENABLED: '' })).toBe(true);
    expect(isMetricsEnabled({ METRICS_ENABLED: 'true' })).toBe(true);
    expect(isMetricsEnabled({ METRICS_ENABLED: 'FALSE' })).toBe(false);
    expect(isMetricsEnabled({ METRICS_ENABLED: null as unknown as string })).toBe(true);
  });

  it('metricsServerConfigFromEnv: дефолты, значения и валидация порта', () => {
    expect(metricsServerConfigFromEnv().port).toBe(9464);
    expect(metricsServerConfigFromEnv({})).toEqual({ port: 9464, host: '0.0.0.0', token: undefined });
    expect(
      metricsServerConfigFromEnv({ METRICS_PORT: '9999', METRICS_HOST: '127.0.0.1', METRICS_TOKEN: ' secret ' })
    ).toEqual({ port: 9999, host: '127.0.0.1', token: 'secret' });
    expect(metricsServerConfigFromEnv({ METRICS_PORT: 'abc' }).port).toBe(9464);
    expect(metricsServerConfigFromEnv({ METRICS_PORT: '0' }).port).toBe(9464);
    expect(metricsServerConfigFromEnv({ METRICS_PORT: '70000' }).port).toBe(9464);
    expect(metricsServerConfigFromEnv({ METRICS_HOST: '  ' }).host).toBe('0.0.0.0');
  });

  it('отдаёт метрики и healthz, остальное — 404', async () => {
    const port = await listen();
    const metrics = await httpRequest(port, '/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain('memes_bot_updates_total');

    const health = await httpRequest(port, '/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toBe('ok');

    expect((await httpRequest(port, '/nope')).status).toBe(404);
    expect((await httpRequest(port, '/metrics?x=1')).status).toBe(200);

    const notFound = await httpRequest(port, '/nope');
    expect(notFound.body).toBe('not found');
  });

  it('POST /metrics → 404', async () => {
    const port = await listen();
    const response = await httpRequest(port, '/metrics', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('токен обязателен при METRICS_TOKEN', async () => {
    const port = await listen('s3cret');
    expect((await httpRequest(port, '/metrics')).status).toBe(401);
    expect((await httpRequest(port, '/metrics', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await httpRequest(port, '/metrics', { headers: { authorization: 'Bearer secret' } })).status).toBe(401);
    expect((await httpRequest(port, '/metrics', { headers: { authorization: 'Basic s3cret' } })).status).toBe(401);
    expect((await httpRequest(port, '/metrics', { headers: { authorization: 'bearer s3cret' } })).status).toBe(200);
  });

  it('ошибка рендера → 500', async () => {
    jest.spyOn(renderModule, 'renderMetrics').mockRejectedValue(new Error('boom'));
    const port = await listen();
    const response = await httpRequest(port, '/metrics');
    expect(response.status).toBe(500);
    expect(response.body).toContain('boom');
  });

  it('не-Error в рендере → 500 со строкой', async () => {
    jest.spyOn(renderModule, 'renderMetrics').mockRejectedValue('plain');
    const port = await listen();
    const response = await httpRequest(port, '/metrics');
    expect(response.status).toBe(500);
    expect(response.body).toContain('plain');
  });

  it('обработчик переживает отсутствующий url и массив Authorization', async () => {
    const handler = createMetricsRequestHandler('a');
    const makeRes = () => ({ writeHead: jest.fn(), end: jest.fn() });

    const resNoUrl = makeRes();
    handler({ method: 'GET', headers: {} } as never, resNoUrl as never);
    expect(resNoUrl.writeHead).toHaveBeenCalledWith(404, expect.anything());

    const resArray = makeRes();
    handler(
      { method: 'GET', url: '/metrics', headers: { authorization: ['Bearer a'] } } as never,
      resArray as never
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(resArray.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });

  it('healthz не требует токена', async () => {
    const port = await listen('s3cret');
    expect((await httpRequest(port, '/healthz')).status).toBe(200);
  });

  it('startMetricsServerFromEnv поднимает и останавливает сервер', () => {
    const env = { ...process.env, METRICS_PORT: '19464', METRICS_HOST: '127.0.0.1' };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = startMetricsServerFromEnv(env);
    expect(server).toBeDefined();
    server!.emit('error', new Error('probe'));
    expect(errorSpy).toHaveBeenCalled();
    server!.close();
  });

  it('startMetricsServerFromEnv возвращает undefined при выключении', () => {
    const server = startMetricsServerFromEnv({ METRICS_ENABLED: 'false' });
    expect(server).toBeUndefined();
  });

  it('createMetricsRequestHandler возвращает функцию', () => {
    expect(typeof createMetricsRequestHandler()).toBe('function');
  });
});
