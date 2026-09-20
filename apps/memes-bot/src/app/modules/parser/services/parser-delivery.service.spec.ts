import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ObservedStatus, QUEUE_MERGE_SIMILARITY, VIDEO_MERGE_SIMILARITY } from '../constants/parser.constants';
import { ParserDeliveryService } from './parser-delivery.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

jest.mock('imghash', () => ({
  hash: jest.fn().mockResolvedValue('abcd1234efgh5678'),
}));

const NOW = new Date('2026-09-19T12:00:00Z');

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

const source = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  chatId: '-1008888888888',
  rawChatId: '8888888888',
  username: 'memes_source',
  title: 'Memes',
  category: 'memes',
  status: 'active',
  selectedTotal: 0,
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): any => ({
  id: 10,
  sourceChatId: '-1008888888888',
  sourceMessageId: 42,
  mediaKind: 'photo',
  caption: null,
  views: 4000,
  reactions: 50,
  score: 4.2,
  status: ObservedStatus.SELECTED,
  imageHash: null,
  forced: false,
  ...overrides,
});

const messageWithPhoto = (): any => {
  const photo = new Api.Photo({
    id: bigInt('555000'),
    accessHash: bigInt('1'),
    fileReference: Buffer.from([]),
    date: 1000,
    sizes: [],
    dcId: 2,
  });
  return { id: 42, photo, video: undefined, views: 4000 } as unknown as Api.Message;
};

const videoDocument = (): any =>
  new Api.Document({
    id: bigInt('777'),
    accessHash: bigInt('1'),
    fileReference: Buffer.from([]),
    date: 1000,
    attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 640, h: 640 })],
    mimeType: 'video/mp4',
    size: bigInt('1000'),
    dcId: 2,
    thumbs: [new Api.PhotoSize({ type: 'm', w: 1, h: 1, size: 1 })],
  });

const messageWithVideo = (overrides: Record<string, unknown> = {}): any =>
  ({ id: 42, photo: undefined, video: videoDocument(), views: 4000, ...overrides }) as unknown as Api.Message;

const makeBot = (): any => ({
  api: {
    sendPhoto: jest.fn().mockResolvedValue({ message_id: 5555 }),
    sendVideo: jest.fn().mockResolvedValue({ message_id: 5556 }),
    editMessageCaption: jest.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  },
});

const makeConfig = (): any => ({
  userRequestMemeChannel: -1004444444444,
  memeChanelId: -1001111111111,
});

const makeGuard = (): any => ({
  run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => fn()),
  pace: jest.fn().mockResolvedValue(undefined),
});

const makeRegistry = (overrides: Record<string, unknown> = {}): any => ({
  repository: {
    findOne: jest.fn().mockResolvedValue(source(overrides)),
    save: jest.fn().mockResolvedValue(undefined),
  },
});

const makeParserClient = (client: Record<string, unknown>): any => ({
  client: jest.fn(() => client),
});

const makeDedup = (): any => ({
  checkDuplicate: jest.fn().mockResolvedValue([]),
  checkDuplicateSameLength: jest.fn().mockResolvedValue([]),
  createPublishedPostHash: jest.fn().mockResolvedValue(undefined),
  calculateHashDistance: jest.fn((a: string, b: string) => {
    if (!a || !b || a.length !== b.length) return 0;
    let match = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) match++;
    return match / a.length;
  }),
});

const makeClock = (): any => ({ now: jest.fn(() => NOW) });

interface SetupOverrides {
  source?: Record<string, unknown>;
  download?: unknown;
  messages?: unknown[];
  client?: Record<string, unknown>;
}

const setup = (overrides: SetupOverrides = {}) => {
  const observedRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation(async (value) => value),
  };
  const client: Record<string, unknown> = {
    getMessages: jest.fn().mockResolvedValue(overrides.messages ?? [messageWithPhoto()]),
    downloadMedia: jest.fn().mockResolvedValue(overrides.download ?? Buffer.from([1, 2, 3])),
    ...overrides.client,
  };
  const bot = makeBot();
  const registry = makeRegistry(overrides.source ?? {});
  const dedup = makeDedup();
  const service = new ParserDeliveryService(
    bot,
    makeConfig(),
    makeGuard(),
    registry,
    makeParserClient(client),
    dedup,
    observedRepo,
    makeClock()
  );
  return { service, observedRepo, bot, dedup, client, registry };
};

describe('ParserDeliveryService', () => {
  it('доставка фото: карточка в предложку и хеши', async () => {
    const { service, observedRepo, bot, dedup } = setup();
    const row = candidate();

    const result = await service.deliver(row);

    expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
    expect(bot.api.sendPhoto).toHaveBeenCalledWith(
      -1004444444444,
      expect.anything(),
      expect.objectContaining({
        parse_mode: 'HTML',
        disable_notification: true,
        caption: expect.stringContaining('🧭 Парсер'),
      })
    );
    expect(row.requestChannelMessageId).toBe(5555);
    expect(row.status).toBe(ObservedStatus.DELIVERED);
    expect(row.imageHash).toBe('abcd1234efgh5678');
    expect(row.perceptualHash).toBe('abcd1234efgh5678');
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.DELIVERED, deliveredAt: NOW })
    );
    expect(dedup.checkDuplicateSameLength).toHaveBeenCalledWith('abcd1234efgh5678');
  });

  it('видео уходит через sendVideo, обложка хешируется 64-бит', async () => {
    const { service, bot } = setup({ messages: [messageWithVideo()] });
    const row = candidate({ mediaKind: 'video' });

    const result = await service.deliver(row);

    expect(result).toMatchObject({ ok: true });
    expect(bot.api.sendVideo).toHaveBeenCalledWith(
      -1004444444444,
      expect.anything(),
      expect.objectContaining({ caption: expect.stringContaining('🧭 Парсер') })
    );
    expect(row.imageHash).toBeNull();
    expect(row.perceptualHash).toBe('abcd1234efgh5678');
  });

  it('видео без обложки → без хешей и без дедупа', async () => {
    const video = videoDocument();
    (video as { thumbs?: unknown[] }).thumbs = [];
    const { service, observedRepo, dedup } = setup({
      messages: [{ id: 42, photo: undefined, video, views: 4000 } as unknown as Api.Message],
    });

    const result = await service.deliver(candidate({ mediaKind: 'video' }));

    expect(result).toMatchObject({ ok: true });
    expect(dedup.checkDuplicateSameLength).not.toHaveBeenCalled();
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ perceptualHash: null })
    );
  });

  it('imghash падает → доставляем без дедупа', async () => {
    const { hash } = jest.requireMock('imghash') as { hash: jest.Mock };
    hash.mockRejectedValueOnce(new Error('bad image'));

    const { service, dedup } = setup();
    const row = candidate();

    const result = await service.deliver(row);

    expect(result).toMatchObject({ ok: true });
    expect(dedup.checkDuplicateSameLength).not.toHaveBeenCalled();
    expect(row.imageHash).toBeNull();
  });

  it('дубль опубликованного → DUPLICATE без отправки', async () => {
    const { service, bot, dedup } = setup();
    dedup.checkDuplicateSameLength.mockResolvedValue([{ memePostId: 1, distance: 0.9 }]);

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.DUPLICATE });
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();
  });

  it('медиа слишком большое → FAILED media-too-large', async () => {
    const { service, bot } = setup({ download: Buffer.alloc(11 * 1024 * 1024, 1) });

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();
  });

  it('видео больше лимита → FAILED', async () => {
    const { service, bot } = setup({
      messages: [messageWithVideo()],
      download: Buffer.alloc(46 * 1024 * 1024, 1),
    });

    const result = await service.deliver(candidate({ mediaKind: 'video' }));

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
    expect(bot.api.sendVideo).not.toHaveBeenCalled();
  });

  it('sendPhoto падает → FAILED send-failed', async () => {
    const { service, bot } = setup();
    bot.api.sendPhoto.mockRejectedValue(new Error('telegram down'));

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('sendPhoto падает без 429 → одна попытка', async () => {
    const { service, bot } = setup();
    bot.api.sendPhoto.mockRejectedValue(new Error('telegram down'));

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
    expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('429 flood-wait → повтор и успешная доставка', async () => {
    jest.useFakeTimers();
    try {
      const { service, bot } = setup();
      bot.api.sendPhoto
        .mockRejectedValueOnce({ error: { error_code: 429, parameters: { retry_after: 1 } } })
        .mockResolvedValueOnce({ message_id: 5555 });

      const promise = service.deliver(candidate());
      await flushMicrotasks();
      jest.advanceTimersByTime(2500);
      await flushMicrotasks();
      const result = await promise;

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('429 исчерпывает попытки → FAILED', async () => {
    jest.useFakeTimers();
    try {
      const { service, bot } = setup();
      bot.api.sendPhoto.mockRejectedValue({ error: { error_code: 429, parameters: { retry_after: 1 } } });

      const promise = service.deliver(candidate());
      await flushMicrotasks();
      jest.advanceTimersByTime(2500);
      await flushMicrotasks();
      jest.advanceTimersByTime(2500);
      await flushMicrotasks();
      const result = await promise;

      expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retryAfterSeconds распознаёт варианты ошибок', () => {
    const { service } = setup();
    const retryAfter = (
      service as never as { retryAfterSeconds: (error: unknown) => number }
    ).retryAfterSeconds.bind(service);

    expect(retryAfter({ error: { error_code: 429, parameters: { retry_after: 7 } } })).toBe(7);
    expect(retryAfter({ error: { error_code: 429 } })).toBe(1);
    expect(retryAfter({ parameters: { retry_after: 3 } })).toBe(3);
    expect(retryAfter({})).toBe(0);
    expect(retryAfter(new Error('nope'))).toBe(0);
  });

  it('источник отсутствует → FAILED source-missing', async () => {
    const setupData = setup();
    setupData.registry.repository.findOne.mockResolvedValue(null);

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('getMessages не нашёл сообщение → FAILED media-fetch-failed', async () => {
    const setupData = setup({ messages: [] });

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('getMessages с null-элементом → FAILED media-fetch-failed', async () => {
    const setupData = setup({ messages: [null] });

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('нет активного клиента → FAILED media-fetch-failed', async () => {
    const setupData = setup({});
    (setupData.service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('пустой буфер → FAILED media-download-empty', async () => {
    const setupData = setup({ download: Buffer.alloc(0) });

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  describe('склейка карточек в предложке', () => {
    it('совпадение хеша → старую карточку удаляем, новый получает источники', async () => {
      const setupData = setup();
      const primary: any = {
        id: 9,
        sourceChatId: '-100111',
        rootSourceChatId: null,
        rootSourceTitle: null,
        rootSourceUsername: null,
        requestChannelMessageId: 999,
        perceptualHash: 'abcd1234efgh5678',
        extraSources: null,
        status: ObservedStatus.DELIVERED,
      };
      setupData.observedRepo.find.mockResolvedValue([primary]);
      const row = candidate({ id: 10 });

      const result = await setupData.service.deliver(row);

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      expect(setupData.bot.api.deleteMessage).toHaveBeenCalledWith(-1004444444444, 999);
      expect(primary.status).toBe(ObservedStatus.DUPLICATE);
      expect(primary.rejectReason).toBe('superseded-by-10');
      expect(primary.duplicateOfId).toBe(10);
      expect(row.rootSourceChatId).toBe('-100111');
      expect(row.extraSources).toEqual([
        { chatId: '-1008888888888', title: 'Memes', username: 'memes_source' },
      ]);
      expect(setupData.bot.api.sendPhoto).toHaveBeenCalled();
    });

    it('уже известный корневой источник дедуплицируется в extraSources', async () => {
      const setupData = setup();
      const primary: any = {
        id: 9,
        sourceChatId: '-1008888888888',
        rootSourceChatId: '-1008888888888',
        rootSourceTitle: 'Root',
        rootSourceUsername: 'root',
        requestChannelMessageId: 999,
        perceptualHash: 'abcd1234efgh5678',
        extraSources: null,
        status: ObservedStatus.DELIVERED,
      };
      setupData.observedRepo.find.mockResolvedValue([primary]);

      const row = candidate({ id: 11 });
      await setupData.service.deliver(row);

      expect(row.rootSourceChatId).toBe('-1008888888888');
      expect(row.extraSources).toEqual([]);
    });

    it('слабый перцептивный хеш не склеивает карточки', async () => {
      const setupData = setup();
      setupData.observedRepo.find.mockResolvedValue([
        {
          id: 9,
          sourceChatId: '-100111',
          requestChannelMessageId: 999,
          perceptualHash: 'ffffffffffffffff',
          extraSources: null,
          status: ObservedStatus.DELIVERED,
        },
      ]);
      setupData.dedup.calculateHashDistance.mockReturnValue(QUEUE_MERGE_SIMILARITY - 0.01);

      const result = await setupData.service.deliver(candidate());

      expect(result).toMatchObject({ ok: true });
      expect(setupData.bot.api.deleteMessage).not.toHaveBeenCalled();
      expect(setupData.bot.api.sendPhoto).toHaveBeenCalled();
    });

    it('доп. источник, совпадающий с новым, не дублируется', async () => {
      const setupData = setup();
      setupData.observedRepo.find.mockResolvedValue([
        {
          id: 9,
          sourceChatId: '-100111',
          rootSourceChatId: '-100111',
          rootSourceTitle: 'Root',
          rootSourceUsername: 'root',
          requestChannelMessageId: 999,
          perceptualHash: 'abcd1234efgh5678',
          extraSources: [{ chatId: '-1008888888888', title: 'Memes', username: 'memes_source' }],
          status: ObservedStatus.DELIVERED,
        },
      ]);

      const row = candidate({ id: 15 });
      await setupData.service.deliver(row);

      expect(row.extraSources).toEqual([
        { chatId: '-1008888888888', title: 'Memes', username: 'memes_source' },
      ]);
    });

    it('строки с null-хешем в выборке игнорируются; score null доставляется', async () => {
      const setupData = setup();
      setupData.observedRepo.find.mockResolvedValue([
        { id: 99, sourceChatId: '-100222', perceptualHash: null, status: ObservedStatus.DELIVERED },
        {
          id: 9,
          sourceChatId: '-100111',
          rootSourceChatId: '-100111',
          requestChannelMessageId: null,
          perceptualHash: 'abcd1234efgh5678',
          extraSources: null,
          status: ObservedStatus.DELIVERED,
        },
      ]);

      const result = await setupData.service.deliver(candidate({ id: 14, score: null }));

      expect(result).toMatchObject({ ok: true });
      expect(setupData.bot.api.deleteMessage).not.toHaveBeenCalled();
    });

    it('видео склеивается по более строгому порогу VIDEO_MERGE_SIMILARITY', async () => {
      const setupData = setup({ messages: [messageWithVideo()] });
      setupData.dedup.calculateHashDistance.mockReturnValue(VIDEO_MERGE_SIMILARITY - 0.01);
      setupData.observedRepo.find.mockResolvedValue([
        {
          id: 9,
          sourceChatId: '-100111',
          rootSourceChatId: '-100111',
          requestChannelMessageId: 999,
          perceptualHash: 'abcd1234efgh5678',
          extraSources: null,
          status: ObservedStatus.DELIVERED,
        },
      ]);

      const result = await setupData.service.deliver(candidate({ mediaKind: 'video' }));

      expect(result).toMatchObject({ ok: true });
      expect(setupData.bot.api.deleteMessage).not.toHaveBeenCalled();
      expect(setupData.bot.api.sendVideo).toHaveBeenCalled();
    });

    it('фото с тем же расстоянием склеивается по QUEUE_MERGE_SIMILARITY', async () => {
      const setupData = setup();
      setupData.dedup.calculateHashDistance.mockReturnValue(VIDEO_MERGE_SIMILARITY - 0.01);
      setupData.observedRepo.find.mockResolvedValue([
        {
          id: 9,
          sourceChatId: '-100111',
          rootSourceChatId: '-100111',
          requestChannelMessageId: 999,
          perceptualHash: 'abcd1234efgh5678',
          extraSources: null,
          status: ObservedStatus.DELIVERED,
        },
      ]);

      await setupData.service.deliver(candidate({ mediaKind: 'photo' }));

      expect(setupData.bot.api.deleteMessage).toHaveBeenCalledWith(-1004444444444, 999);
    });

    it('удаление старой карточки падает → помечаем подписью', async () => {
      const setupData = setup();
      setupData.bot.api.deleteMessage.mockRejectedValue(new Error('no rights'));
      setupData.observedRepo.find.mockResolvedValue([
        {
          id: 9,
          sourceChatId: '-100111',
          requestChannelMessageId: 999,
          perceptualHash: 'abcd1234efgh5678',
          extraSources: null,
          status: ObservedStatus.DELIVERED,
        },
      ]);

      await setupData.service.deliver(candidate({ id: 12 }));

      expect(setupData.bot.api.editMessageCaption).toHaveBeenCalledWith(
        -1004444444444,
        999,
        expect.objectContaining({ caption: expect.stringContaining('Дубль') })
      );
    });

    it('и старая, и новая пометки падают — не роняем доставку', async () => {
      const setupData = setup();
      setupData.bot.api.deleteMessage.mockRejectedValue(new Error('no rights'));
      setupData.bot.api.editMessageCaption.mockRejectedValue(new Error('gone'));
      setupData.observedRepo.find.mockResolvedValue([
        {
          id: 9,
          sourceChatId: '-100111',
          requestChannelMessageId: 999,
          perceptualHash: 'abcd1234efgh5678',
          extraSources: null,
          status: ObservedStatus.DELIVERED,
        },
      ]);

      await expect(setupData.service.deliver(candidate({ id: 13 }))).resolves.toMatchObject({ ok: true });
    });
  });

  describe('подписи и клавиатуры', () => {
    it('подпись карточки: категория, источник, метрики', () => {
      const { service } = setup();
      const caption = service.buildCaption(candidate(), source());
      expect(caption).toContain('🧭 Парсер');
      expect(caption).toContain('Memes');
      expect(caption).toContain('4.0K');
      expect(caption).toContain('50');
      expect(caption).toContain('4.2');
    });

    it('кринж-категория меняет метку', () => {
      const { service } = setup();
      const caption = service.buildCaption(candidate(), source({ category: 'cringe' }));
      expect(caption).toContain('кринж');
    });

    it('подпись без метрик и источника', () => {
      const { service } = setup();
      const caption = service.buildCaption(
        candidate({ views: null, reactions: null, score: null }),
        source({ username: null, title: null })
      );
      expect(caption).not.toContain('👁');
      expect(caption).toContain('источник');
    });

    it('корневой источник и счётчик +N и форс', () => {
      const { service } = setup();
      const merged = candidate({
        rootSourceChatId: '-100999',
        rootSourceTitle: 'Root',
        rootSourceUsername: 'root',
        extraSources: [
          { chatId: '-100777', title: 'Второй', username: 'second' },
          { chatId: '-100778', title: 'Третий', username: null },
        ],
        forced: true,
      });
      const caption = service.buildCaption(merged, source());
      expect(caption).toContain('https://t.me/root');
      expect(caption).toContain('+2');
      expect(caption).toContain('⚡️ форс');
    });

    it('buildExtraSourceLink: username, приватный и нечисловой chatId', () => {
      const { service } = setup();
      expect(
        service.buildExtraSourceLink({ chatId: '-100123', title: 'T', username: 'u' })
      ).toContain('https://t.me/u');
      expect(
        service.buildExtraSourceLink({ chatId: '-1000000000123', title: null, username: null })
      ).toContain('https://t.me/c/123');
      expect(
        service.buildExtraSourceLink({ chatId: 'not-a-number', title: null, username: null })
      ).toContain('https://t.me/c/');
    });

    it('buildSourceLink: username и внутренняя форма', () => {
      const { service } = setup();
      expect(service.buildSourceLink(source({ username: 'chan', title: 'Memes' }))).toContain(
        'https://t.me/chan'
      );
      expect(
        service.buildSourceLink(source({ username: null, title: null, chatId: '-1000000000123' }))
      ).toContain('https://t.me/c/123');
    });

    it('клавиатура карточки — 3 строки с исключением источника', () => {
      const { service } = setup();
      const keyboard = service.buildKeyboard(7) as unknown as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(keyboard.inline_keyboard[0]).toEqual([
        { text: '▶️ Сейчас', callback_data: 'prs:now:7' },
        { text: '📋 В очередь', callback_data: 'prs:q:7' },
      ]);
      expect(keyboard.inline_keyboard[1]).toEqual([
        { text: '🌙 В ночь (кринж)', callback_data: 'prs:night:7' },
        { text: '🗑 Отклонить', callback_data: 'prs:rej:7' },
      ]);
      expect(keyboard.inline_keyboard[2]).toEqual([
        { text: '🚫 Исключить источник', callback_data: 'prs:excl:7' },
      ]);
    });

    it('buildExcludeConfirmKeyboard', () => {
      const { service } = setup();
      const keyboard = service.buildExcludeConfirmKeyboard(7) as unknown as {
        inline_keyboard: Array<Array<{ callback_data: string }>>;
      };
      expect(keyboard.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
        'prs:exclok:7',
        'prs:exclno:7',
      ]);
    });
  });

  describe('кнопка «Ещё 20»', () => {
    it('attachMoreButton добавляет строку, detachMoreButton убирает', async () => {
      const { service, bot } = setup();

      await service.attachMoreButton(123, 7);
      const attached = bot.api.editMessageReplyMarkup.mock.calls[0][2].reply_markup as unknown as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(attached.inline_keyboard.at(-1)).toEqual([
        { text: '🍲 Ещё 20', callback_data: 'prs:more:7' },
      ]);

      await service.detachMoreButton(123, 7);
      const detached = bot.api.editMessageReplyMarkup.mock.calls[1][2].reply_markup as unknown as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(detached.inline_keyboard.flat().some((b) => b.callback_data.startsWith('prs:more:'))).toBe(
        false
      );
    });

    it('ошибка редактирования клавиатуры не роняет', async () => {
      const { service, bot } = setup();
      bot.api.editMessageReplyMarkup.mockRejectedValue(new Error('message is not modified'));
      await expect(service.attachMoreButton(123, 7)).resolves.toBeUndefined();
    });
  });

  it('видео с обложкой без байтов → без хеша', async () => {
    const { service, client, dedup } = setup({ messages: [messageWithVideo()] });
    (client.downloadMedia as jest.Mock)
      .mockResolvedValueOnce(Buffer.from([1, 2, 3]))
      .mockResolvedValueOnce(null);

    const result = await service.deliver(candidate({ mediaKind: 'video' }));

    expect(result).toMatchObject({ ok: true });
    expect(dedup.checkDuplicateSameLength).not.toHaveBeenCalled();
  });

  it('sendCard без медиа → null', async () => {
    const { service } = setup();
    const result = await (service as never as { sendCard: (...args: unknown[]) => Promise<unknown> }).sendCard(candidate(), source(), {});
    expect(result).toBeNull();
  });

  it('downloadThumb без клиента → null', async () => {
    const { service } = setup();
    (service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);
    const result = await (
      service as never as { downloadThumb: (m: unknown) => Promise<Buffer | null> }
    ).downloadThumb(messageWithVideo());
    expect(result).toBeNull();
  });
});
