import { request } from 'http';
import { AddressInfo } from 'net';

import { startMetricsServer } from '../../src/app/shared/metrics';
import { E2EHarness, createE2EHarness, privateMessageUpdate } from './harness';

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('E2E: экспорт метрик', () => {
  let h: E2EHarness;

  beforeEach(async () => {
    h = await createE2EHarness();
    await h.resetDb();
  });

  afterEach(async () => {
    await h.close();
  });

  it('после апдейта /metrics отдаёт счётчики обновлений и Telegram API', async () => {
    await h.sendUpdate(privateMessageUpdate({ text: '/start' }));

    const server = startMetricsServer({ port: 0, host: '127.0.0.1' });
    const port = await new Promise<number>((resolve) =>
      server.on('listening', () => resolve((server.address() as AddressInfo).port))
    );

    try {
      const response = await httpGet(port, '/metrics');
      expect(response.status).toBe(200);
      expect(response.body).toContain('memes_bot_updates_total');
      expect(response.body).toMatch(/memes_bot_updates_total\{[^}]*type="message"/);
      expect(response.body).toMatch(
        /memes_bot_telegram_api_requests_total\{[^}]*method="sendMessage"/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
