import {
  createMetricsRequestHandler,
  isMetricsEnabled,
  metrics,
  metricsContentType,
  renderMetrics,
  setGaugeCollector,
  sourceLabel,
  startMetricsServerFromEnv,
} from './index';

describe('metrics barrel', () => {
  it('экспортирует публичное API', async () => {
    expect(typeof isMetricsEnabled).toBe('function');
    expect(typeof createMetricsRequestHandler).toBe('function');
    expect(typeof startMetricsServerFromEnv).toBe('function');
    expect(typeof setGaugeCollector).toBe('function');
    expect(typeof sourceLabel).toBe('function');
    expect(typeof metricsContentType).toBe('function');
    expect(metrics.info).toBeDefined();
    setGaugeCollector(metrics.users.total, () => undefined);
    await renderMetrics();
  });
});
