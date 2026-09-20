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

const makeBot = (): any => ({
  callbackQuery: jest.fn(),
  on: jest.fn(),
  api: { deleteMessage: jest.fn().mockResolvedValue(undefined) },
});

const setup = (overrides: { enabled?: boolean; activeClient?: unknown } = {}) => {
  const settings = makeSettings(overrides.enabled ?? true);
  const registry = {
    listCollectible: jest.fn().mockResolvedValue([{ id: 1, chatId: '-1001' }]),
    refreshSourceStats: jest.fn().mockResolvedValue(undefined),
    refreshCooldowns: jest.fn().mockResolvedValue(2),
  };
  const collector = { onLiveEvent: jest.fn().mockResolvedValue(undefined), sweepAll: jest.fn().mockResolvedValue(0) };
  const evaluator = { evaluateDue: jest.fn().mockResolvedValue(0) };
  const selector = {
    deliverForced: jest.fn().mockResolvedValue(0),
    ageBacklog: jest.fn().mockResolvedValue(0),
    dumpMore: jest.fn().mockResolvedValue(3),
  };
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
  const bot = makeBot();
  const config = { userRequestMemeChannel: -1004444444444 };

  const service = new ParserService(
    settings,
    registry as never,
    collector as never,
    evaluator as never,
    selector as never,
    discovery as never,
    moderation as never,
    parserClient as never,
    clientBase as never,
    bot as never,
    config as never
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
    bot,
    parserClient,
  };
};

describe('ParserService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('onModuleInit: регистрирует карточки, /more и планирует live', () => {
    const { service, moderation, bot, client } = setup();
    service.onModuleInit();

    expect(moderation.registerCallbacks).toHaveBeenCalledTimes(1);
    expect(bot.callbackQuery).toHaveBeenCalledTimes(1);
    expect(bot.on).toHaveBeenCalledWith('channel_post:text', expect.any(Function));
    expect(client.addEventHandler).not.toHaveBeenCalled();
  });

  it('кнопка prs:more у владельца запускает dumpMore', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = { config: { isOwner: true }, answerCallbackQuery: jest.fn() };

    await handler(ctx);

    expect(selector.dumpMore).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Насыпаю…');
  });

  it('кнопка prs:more отклоняет не-владельца', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = { config: { isOwner: false }, answerCallbackQuery: jest.fn() };

    await handler(ctx);

    expect(selector.dumpMore).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Только владелец');
  });

  it('channel_post /more в предложке запускает dumpMore и удаляет команду', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.on.mock.calls[0][1];
    const ctx = {
      chat: { id: -1004444444444 },
      channelPost: { text: '/more', message_id: 9 },
      api: { deleteMessage: jest.fn().mockResolvedValue(undefined) },
    };

    await handler(ctx);

    expect(selector.dumpMore).toHaveBeenCalledTimes(1);
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(-1004444444444, 9);
  });

  it('channel_post /more@bot тоже принимается', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.on.mock.calls[0][1];
    const ctx = {
      chat: { id: -1004444444444 },
      channelPost: { text: '/more@memes_bot', message_id: 9 },
      api: { deleteMessage: jest.fn().mockResolvedValue(undefined) },
    };

    await handler(ctx);
    expect(selector.dumpMore).toHaveBeenCalledTimes(1);
  });

  it('кнопка prs:more без config считается чужой', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.callbackQuery.mock.calls[0][1];
    const ctx = { answerCallbackQuery: jest.fn() };

    await handler(ctx);

    expect(selector.dumpMore).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Только владелец');
  });

  it('channel_post без chat/text не роняет', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.on.mock.calls[0][1];

    await expect(handler({ channelPost: {}, api: {} })).resolves.toBeUndefined();
    expect(selector.dumpMore).not.toHaveBeenCalled();
  });

  it('повторный тик с тем же клиентом не переподключается', async () => {
    jest.useFakeTimers();
    const { service, client } = setup();
    service.onModuleInit();
    jest.advanceTimersByTime(30_000);
    await flush();
    jest.advanceTimersByTime(30_000);
    await flush();

    expect(client.addEventHandler).toHaveBeenCalledTimes(1);
  });

  it('channel_post из чужого чата / не команда игнорируется', async () => {
    const { service, bot, selector } = setup();
    service.onModuleInit();
    const handler = bot.on.mock.calls[0][1];

    await handler({ chat: { id: -100999 }, channelPost: { text: '/more', message_id: 9 }, api: {} });
    await handler({
      chat: { id: -1004444444444 },
      channelPost: { text: 'просто текст', message_id: 9 },
      api: {},
    });

    expect(selector.dumpMore).not.toHaveBeenCalled();
  });

  it('ошибка удаления команды /more не роняет обработчик', async () => {
    const { service, bot } = setup();
    service.onModuleInit();
    const handler = bot.on.mock.calls[0][1];
    const ctx = {
      chat: { id: -1004444444444 },
      channelPost: { text: '/more', message_id: 9 },
      api: { deleteMessage: jest.fn().mockRejectedValue(new Error('gone')) },
    };

    await expect(handler(ctx)).resolves.toBeUndefined();
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

  it('live-обработчик подключается и зовёт коллектор', async () => {
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

  it('пересозданный клиент → повторный attach', async () => {
    jest.useFakeTimers();
    const { service, client, clientBase } = setup();
    service.onModuleInit();
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(client.addEventHandler).toHaveBeenCalledTimes(1);

    const client2 = { addEventHandler: jest.fn() };
    (clientBase as { activeClient: unknown }).activeClient = client2;
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(client2.addEventHandler).toHaveBeenCalledTimes(1);
  });

  it('кроны работают при включённом конвейере', async () => {
    const { service, collector, evaluator, selector, discovery } = setup();

    await service.onSweep();
    await service.onEvaluate();
    await service.onSelect();
    await service.onDiscovery();

    expect(collector.sweepAll).toHaveBeenCalledTimes(1);
    expect(evaluator.evaluateDue).toHaveBeenCalledTimes(1);
    expect(selector.deliverForced).toHaveBeenCalledTimes(1);
    expect(selector.ageBacklog).toHaveBeenCalledTimes(1);
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
    expect(selector.deliverForced).not.toHaveBeenCalled();
    expect(discovery.runWebCheck).not.toHaveBeenCalled();
  });

  it('onStats обновляет статистику и снимает cooldown', async () => {
    const { service, registry } = setup();

    await service.onStats();

    expect(registry.refreshSourceStats).toHaveBeenCalledTimes(1);
    expect(registry.refreshCooldowns).toHaveBeenCalledTimes(1);
  });

  it('onStats без клиента → выход', async () => {
    const { service, registry, parserClient } = setup();
    parserClient.client.mockReturnValue(undefined);

    await service.onStats();

    expect(registry.listCollectible).not.toHaveBeenCalled();
  });

  it('onStats: ошибка источника не роняет прогон', async () => {
    const { service, registry } = setup();
    registry.refreshSourceStats.mockRejectedValue(new Error('parse fail'));

    await expect(service.onStats()).resolves.toBeUndefined();
    expect(registry.refreshCooldowns).toHaveBeenCalled();
  });
});
