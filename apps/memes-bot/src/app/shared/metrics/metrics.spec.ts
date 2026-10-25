import { initMetrics, metrics, registry, setGaugeCollector, sourceLabel } from './metrics';
import { metricsContentType, renderMetrics } from './render';

describe('metrics core', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sourceLabel: только username либо константа source', () => {
    expect(sourceLabel({ username: 'memes', title: 'Title', chatId: '-100' })).toBe('@memes');
    expect(sourceLabel({ username: '@memes' })).toBe('@memes');
    // Название канала и chat id — не метки: иначе каждая правка названия/новый
    // чат создаёт новую серию Prometheus (TGB-121).
    expect(sourceLabel({ username: '  ', title: 'Title' })).toBe('source');
    expect(sourceLabel({ chatId: 123 })).toBe('source');
    expect(sourceLabel({})).toBe('source');
    expect(sourceLabel({ username: null, title: null, chatId: null })).toBe('source');
  });

  it('sourceLabel не плодит серии по chat id и названию', () => {
    const labels = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      labels.add(
        sourceLabel({ username: null, title: `Канал ${index}`, chatId: -1000000000000 - index })
      );
    }
    expect(labels.size).toBe(1);
    expect([...labels]).toEqual(['source']);
  });

  it('initMetrics идемпотентен и добавляет default-метрики и info', async () => {
    initMetrics();
    initMetrics();
    const body = await renderMetrics();
    expect(body).toContain('memes_bot_info');
    expect(body).toContain('process_cpu_seconds_total');
    expect(body).toContain('app="memes-bot"');
    expect(metricsContentType()).toContain('text/plain');
  });

  it('реестр отдаёт значение info с версией и node', async () => {
    initMetrics();
    const info = await metrics.info.get();
    const labels = info.values[0].labels;
    expect(labels.version).toBeDefined();
    expect(labels.node).toBeDefined();
    expect(registry.contentType).toContain('text/plain');
  });

  it('задаёт default-метку приложения', async () => {
    const rendered = await registry.metrics();
    expect(rendered).toContain('app="memes-bot"');
  });

  it('setGaugeCollector регистрирует функцию сбора', async () => {
    const collect = jest.fn();
    setGaugeCollector(metrics.parser.sourcesByStatus, collect);
    await metrics.parser.sourcesByStatus.get();
    expect(collect).toHaveBeenCalled();
  });
});
