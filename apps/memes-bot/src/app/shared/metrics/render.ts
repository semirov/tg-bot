import { registry } from './metrics';

/** Рендерит все метрики реестра в формате Prometheus exposition. */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** Content-Type ответа Prometheus. */
export function metricsContentType(): string {
  return registry.contentType;
}
