import { ParserService } from './parser.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

const makeSettings = (enabled = true): any => ({
  current: { enabled },
  enabled,
});

const setup = (overrides: { enabled?: boolean; activeClient?: unknown } = {}) => {
  const settings = makeSettings(overrides.enabled ?? true);
  const registry = {
    listCollectible: jest.fn().mockResolvedValue([{ id: 1, chatId: '-1001' }]),
    refreshSourceStats: jest.fn().mockResolvedValue(undefined),
    pruneWeakSources: jest.fn().mockResolvedValue(2),
  };
  const collector = { onLiveEvent: jest.fn().mockResolvedValue(undefined), sweepAll: jest.fn().mockResolvedValue(0) };
  const evaluator = { evaluateDue: jest.fn().mockResolvedValue(0) };
  const selector = { selectAndDeliver: jest.fn().mockResolvedValue(0) };
  const discovery = { runWebCheck: jest.fn().mockResolvedValue(0) };
  const moderation = { registerCallbacks: jest.fn() };
  const client = { addEventHandler: jest.fn() };
  const clientBase = {
    activeClient:
      overrides.activeClient === undefined
        ? client
        : overrides.activeClient === null
          ? undefined
          : overrides.activeClient,
  };
  const parserClient = { client: jest.fn(() => client) };

  const service = new ParserService(
    settings,
    registry as never,
    collector as never,
    evaluator as never,
    selector as never,
    discovery as never,
    moderation as never,
    parserClient as never,
    clientBase as never
  );
  return {
    service,
    settings,
    registry,
    collector,
    evaluator,
    selector,
    discovery,
    moderation,
    client,
    clientBase,
  };
};

describe('ParserService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('onModuleInit: регистрирует callback-обработчики и планирует подключение live', () => {
    const { service, moderation, client } = setup();
    service.onModuleInit();

    expect(moderation.registerCallbacks).toHaveBeenCalledTimes(1);
    expect(client.addEventHandler).not.toHaveBeenCalled();
  });

  it('выключенный конвейер не подключает live', async () => {
    jest.useFakeTimers();
    const { service, client } = setup({ enabled: false });
    service.onModuleInit();

    jest.advanceTimersByTime(60_000);
    await flush();

    expect(client.addEventHandler).not.toHaveBeenCalled();
  });

  it('клиент появляется позже — подключение ждёт', async () => {
    jest.useFakeTimers();
    const setupData = setup({ activeClient: null });
    const { service, clientBase } = setupData as never as {
      service: ParserService;
      clientBase: { activeClient: unknown };
    };
    service.onModuleInit();

    jest.advanceTimersByTime(30_000);
    await flush();
    expect((service as never as { liveHandlerAttached: boolean }).liveHandlerAttached).toBe(false);

    (clientBase as { activeClient: unknown }).activeClient = { addEventHandler: jest.fn() };
    jest.advanceTimersByTime(30_000);
    await flush();
    expect((service as never as { liveHandlerAttached: boolean }).liveHandlerAttached).toBe(true);
  });

  it('live-обработчик подключается, когда юзербот поднят', async () => {
    jest.useFakeTimers();
    const { service, client, collector } = setup();
    service.onModuleInit();

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(client.addEventHandler).toHaveBeenCalledTimes(1);
    expect((service as never as { liveHandlerAttached: boolean }).liveHandlerAttached).toBe(true);

    const handler = client.addEventHandler.mock.calls[0][0];
    await handler({ isChannel: true, chatId: { toString: () => '-1002' }, message: {} });
    await flush();

    expect(collector.onLiveEvent).toHaveBeenCalled();
  });

  it('live-ошибка коллектора не роняет хендлер', async () => {
    jest.useFakeTimers();
    const { service, client, collector } = setup();
    collector.onLiveEvent.mockRejectedValue(new Error('boom'));
    service.onModuleInit();
    jest.advanceTimersByTime(30_000);
    await flush();

    const handler = client.addEventHandler.mock.calls[0][0];
    await expect(handler({ isChannel: true, message: {} })).resolves.toBeUndefined();
  });

  it('кроны работают при включённом конвейере', async () => {
    const { service, collector, evaluator, selector, discovery } = setup();

    await service.onSweep();
    await service.onEvaluate();
    await service.onSelect();
    await service.onDiscovery();

    expect(collector.sweepAll).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluateDue).toHaveBeenCalledTimes(1);
    expect(selector.selectAndDeliver).toHaveBeenCalledTimes(1);
    expect(discovery.runWebCheck).toHaveBeenCalledTimes(1);
  });

  it('кроны выключены при disabled', async () => {
    const { service, collector, evaluator, selector, discovery } = setup({ enabled: false });

    await service.onSweep();
    await service.onEvaluate();
    await service.onSelect();
    await service.onDiscovery();

    expect(collector.sweepAll).not.toHaveBeenCalled();
    expect(evaluator.evaluateDue).not.toHaveBeenCalled();
    expect(selector.selectAndDeliver).not.toHaveBeenCalled();
    expect(discovery.runWebCheck).not.toHaveBeenCalled();
  });

  it('onStats: обновляет статистику источников и прунит', async () => {
    const { service, registry, parserClient } = setup() as never as {
      service: ParserService;
      registry: { listCollectible: jest.Mock; refreshSourceStats: jest.Mock; pruneWeakSources: jest.Mock };
      parserClient: { client: jest.Mock };
    };
    await (service as never as { onStats(): Promise<void> }).onStats();

    expect(registry.refreshSourceStats).toHaveBeenCalledTimes(1);
    expect(registry.pruneWeakSources).toHaveBeenCalledTimes(1);
    void parserClient;
  });
});
