import * as bigInt from 'big-integer';
import { Logger } from '@nestjs/common';
import { Api } from 'telegram';
import {
  MAX_VIDEO_BYTES,
  ObservedStatus,
  QUEUE_MERGE_SIMILARITY,
  VIDEO_MERGE_SIMILARITY,
} from '../constants/parser.constants';
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
  for (let i = 0; i < 300; i += 1) await Promise.resolve();
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

const messageWithPhoto = (
  sizes: Api.TypePhotoSize[] = [new Api.PhotoSize({ type: 'm', w: 320, h: 320, size: 1024 })]
): any => {
  const photo = new Api.Photo({
    id: bigInt('555000'),
    accessHash: bigInt('1'),
    fileReference: Buffer.from([]),
    date: 1000,
    sizes,
    dcId: 2,
  });
  return {
    id: 42,
    photo,
    video: undefined,
    media: new Api.MessageMediaPhoto({ photo }),
    views: 4000,
  } as unknown as Api.Message;
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

const messageWithVideo = (overrides: Record<string, unknown> = {}): any => {
  const video = videoDocument();
  return {
    id: 42,
    photo: undefined,
    media: new Api.MessageMediaDocument({ document: video }),
    video,
    views: 4000,
    ...overrides,
  } as unknown as Api.Message;
};

/** Чанк тестового `iterDownload` — как у gramjs в проде (128 КБ). */
const STREAM_CHUNK_BYTES = 128 * 1024;

/** Фейковый `iterDownload`: отдаёт буфер чанками по 128 КБ, как это делает gramjs. */
const streamChunks = async function* (data: Buffer): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += STREAM_CHUNK_BYTES) {
    yield data.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, data.length));
  }
};

/** Поток, падающий на первом `next()` (ошибка MTProto до первого чанка). */
const failingStream = (error: Error) =>
  async function* (): AsyncGenerator<Buffer> {
    if (error) throw error;
    yield Buffer.alloc(0);
  };

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

const makeGuard = (): any => {
  const state = { blocked: false };
  return {
    state,
    // Как настоящий guard: MTProto-сбой гасится в `undefined`, пауза — без вызова.
    run: jest.fn(async (_op: string, fn: () => Promise<unknown>) => {
      if (state.blocked) return undefined;
      try {
        return await fn();
      } catch {
        return undefined;
      }
    }),
    pace: jest.fn().mockResolvedValue(undefined),
    isBlocked: jest.fn(() => state.blocked),
    blockedUntil: jest.fn(() => (state.blocked ? Date.now() + 60_000 : null)),
  };
};


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
    iterDownload: jest.fn(() =>
      streamChunks((overrides.download as Buffer) ?? Buffer.from([1, 2, 3]))
    ),
    downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
    ...overrides.client,
  };
  const bot = makeBot();
  const registry = makeRegistry(overrides.source ?? {});
  const dedup = makeDedup();
  const guard = makeGuard();
  const service = new ParserDeliveryService(
    bot,
    makeConfig(),
    guard,
    registry,
    makeParserClient(client),
    dedup,
    observedRepo,
    makeClock()
  );
  return { service, observedRepo, bot, dedup, client, registry, guard };
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
      messages: [
        {
          id: 42,
          photo: undefined,
          media: new Api.MessageMediaDocument({ document: video }),
          video,
          views: 4000,
        } as unknown as Api.Message,
      ],
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

  it('дубль опубликованного → DUPLICATE без отправки и warn с similarity', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, bot, dedup } = setup();
    dedup.checkDuplicateSameLength.mockResolvedValue([{ memePostId: 1, distance: 0.9 }]);

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.DUPLICATE });
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('кандидат 10 — дубликат опубликованного (similarity 0.900)')
    );
    warnSpy.mockRestore();
  });

  it('случайная пара (схожесть < порога published-duplicate) → НЕ дубликат', async () => {
    const { service, dedup } = setup();
    // 0.6 — выше случайного шума (~0.48), но ниже порога PUBLISHED_DUPLICATE_SIMILARITY
    dedup.checkDuplicateSameLength.mockResolvedValue([{ memePostId: 7, distance: 0.6 }]);

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
    expect(dedup.checkDuplicateSameLength).toHaveBeenCalled();
  });

  it('медиа слишком большое (размер неизвестен, буфер больше лимита) → FAILED media-too-large', async () => {
    const { service, bot } = setup({ download: Buffer.alloc(11 * 1024 * 1024, 1) });

    const result = await service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED, reason: 'media-too-large' });
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();
  });

  it('видео больше лимита → FAILED', async () => {
    const { service, bot } = setup({
      messages: [messageWithVideo()],
      download: Buffer.alloc(46 * 1024 * 1024, 1),
    });

    const result = await service.deliver(candidate({ mediaKind: 'video' }));

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED, reason: 'media-too-large' });
    expect(bot.api.sendVideo).not.toHaveBeenCalled();
  });

  describe('размер медиа из метаданных (TGB-128)', () => {
    it('объявленное видео > 45 МБ → ни одного скачивания, media-too-large', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const video = videoDocument();
      video.size = bigInt(String(46 * 1024 * 1024));
      const { service, client, bot } = setup({
        messages: [
          {
            id: 42,
            photo: undefined,
            media: new Api.MessageMediaDocument({ document: video }),
            video,
            views: 4000,
          } as unknown as Api.Message,
        ],
      });

      const result = await service.deliver(candidate({ mediaKind: 'video' }));

      expect(result).toMatchObject({
        ok: false,
        status: ObservedStatus.FAILED,
        reason: 'media-too-large',
      });
      expect(client.downloadMedia).not.toHaveBeenCalled();
      expect(client.iterDownload).not.toHaveBeenCalled();
      expect(bot.api.sendVideo).not.toHaveBeenCalled();
      const sizeLogs = warnSpy.mock.calls.filter(([line]) =>
        String(line).includes('media-too-large (')
      );
      expect(sizeLogs).toHaveLength(1);
      expect(sizeLogs[0][0]).toContain(
        `media-too-large (video, ${46 * 1024 * 1024} bytes, chat=-1008888888888, msg=42)`
      );
      warnSpy.mockRestore();
    });

    it('объявленное фото > 10 МБ → ни одного скачивания, media-too-large', async () => {
      const sizes = [
        new Api.PhotoSize({ type: 'm', w: 320, h: 320, size: 1024 }),
        new Api.PhotoSize({ type: 'w', w: 1280, h: 1280, size: 11 * 1024 * 1024 }),
      ];
      const { service, client, bot } = setup({ messages: [messageWithPhoto(sizes)] });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({
        ok: false,
        status: ObservedStatus.FAILED,
        reason: 'media-too-large',
      });
      expect(client.downloadMedia).not.toHaveBeenCalled();
      expect(client.iterDownload).not.toHaveBeenCalled();
      expect(bot.api.sendPhoto).not.toHaveBeenCalled();
    });

    it('размер неизвестен, поток больше лимита → обрыв на cap + один чанк', async () => {
      const consumed = { chunks: 0, bytes: 0 };
      const endless = async function* (): AsyncGenerator<Buffer> {
        const chunk = Buffer.alloc(STREAM_CHUNK_BYTES, 1);
        for (;;) {
          consumed.chunks += 1;
          consumed.bytes += chunk.length;
          yield chunk;
        }
      };
      const iterDownload = jest.fn((_params: Record<string, unknown>) => endless());
      const { service, bot } = setup({ client: { iterDownload } });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({
        ok: false,
        status: ObservedStatus.FAILED,
        reason: 'media-too-large',
      });
      expect(iterDownload).toHaveBeenCalledTimes(1);
      expect(iterDownload.mock.calls[0][0]).toMatchObject({
        requestSize: STREAM_CHUNK_BYTES,
        limit: 10 * 1024 * 1024 / STREAM_CHUNK_BYTES + 1,
      });
      // 80 чанков = ровно лимит фото, 81-й показывает превышение и обрывает поток.
      expect(consumed.chunks).toBe(81);
      expect(consumed.bytes).toBeLessThanOrEqual(10 * 1024 * 1024 + STREAM_CHUNK_BYTES);
      expect(bot.api.sendPhoto).not.toHaveBeenCalled();
    });

    it('объявленное видео <= лимита → bounded-буфер склеен из чанков и доставлен', async () => {
      const source = Buffer.alloc(3 * STREAM_CHUNK_BYTES - 100, 7);
      const { service, client, bot } = setup({
        messages: [messageWithVideo()],
        download: source,
      });

      const result = await service.deliver(candidate({ mediaKind: 'video' }));

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      expect(client.iterDownload).toHaveBeenCalledTimes(1);
      expect((client.iterDownload as jest.Mock).mock.calls[0][0]).toMatchObject({
        requestSize: STREAM_CHUNK_BYTES,
        limit: 45 * 1024 * 1024 / STREAM_CHUNK_BYTES + 1,
      });
      // Три чанка склеены ровно в исходный поток, без потерь и дублей.
      const sent = bot.api.sendVideo.mock.calls[0][1] as { fileData?: Buffer };
      expect(Buffer.compare(sent.fileData ?? Buffer.alloc(0), source)).toBe(0);
    });

    it('объявленный размер ровно равен лимиту → доставляем, не отклоняем', async () => {
      const video = videoDocument();
      video.size = bigInt(String(MAX_VIDEO_BYTES));
      const { service, bot } = setup({
        messages: [
          {
            id: 42,
            photo: undefined,
            media: new Api.MessageMediaDocument({ document: video }),
            video,
            views: 4000,
          } as unknown as Api.Message,
        ],
      });

      const result = await service.deliver(candidate({ mediaKind: 'video' }));

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      expect(bot.api.sendVideo).toHaveBeenCalled();
    });

    it('фото с пустым photo.sizes → media-download-empty (getFileInfo падает на [])', async () => {
      const { service, client } = setup({ messages: [messageWithPhoto([])] });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({
        ok: false,
        status: ObservedStatus.FAILED,
        reason: 'media-download-empty',
      });
      expect(client.iterDownload).not.toHaveBeenCalled();
    });

    it('веб-превью с фото → разворачиваем webpage.photo и доставляем', async () => {
      const photo = new Api.Photo({
        id: bigInt('890'),
        accessHash: bigInt('1'),
        fileReference: Buffer.from([]),
        date: 1000,
        sizes: [new Api.PhotoSize({ type: 'm', w: 320, h: 320, size: 2048 })],
        dcId: 2,
      });
      const message = {
        id: 42,
        photo,
        video: undefined,
        views: 4000,
        media: new Api.MessageMediaWebPage({
          webpage: new Api.WebPage({
            id: bigInt('1'),
            url: 'https://example.com',
            displayUrl: 'example.com',
            hash: 0,
            photo,
          }),
        }),
      } as unknown as Api.Message;
      const { service, client, bot } = setup({ messages: [message] });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      const file = (client.iterDownload as jest.Mock).mock.calls[0][0].file;
      expect(file).toBeInstanceOf(Api.MessageMediaPhoto);
      expect((file as Api.MessageMediaPhoto).photo).toBe(photo);
      expect(bot.api.sendPhoto).toHaveBeenCalled();
    });

    it('веб-превью с видео → разворачиваем webpage.document и доставляем', async () => {
      const video = videoDocument();
      const message = {
        id: 42,
        photo: undefined,
        video,
        views: 4000,
        media: new Api.MessageMediaWebPage({
          webpage: new Api.WebPage({
            id: bigInt('2'),
            url: 'https://example.com/v',
            displayUrl: 'example.com/v',
            hash: 0,
            document: video,
          }),
        }),
      } as unknown as Api.Message;
      const { service, client, bot } = setup({ messages: [message] });

      const result = await service.deliver(candidate({ mediaKind: 'video' }));

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      const file = (client.iterDownload as jest.Mock).mock.calls[0][0].file;
      expect(file).toBeInstanceOf(Api.MessageMediaDocument);
      expect((file as Api.MessageMediaDocument).document).toBe(video);
      expect(bot.api.sendVideo).toHaveBeenCalled();
    });

    it('сообщение без поддерживаемого медиа → media-download-empty без MTProto-скачивания', async () => {
      const { service, client } = setup({
        messages: [{ id: 42, views: 4000 } as unknown as Api.Message],
      });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({
        ok: false,
        status: ObservedStatus.FAILED,
        reason: 'media-download-empty',
      });
      expect(client.iterDownload).not.toHaveBeenCalled();
    });

    it('declaredMediaSize: BigInteger, число, progressive-фото и неизвестный размер', () => {
      const service = setup().service as never as {
        declaredMediaSize: (m: unknown, k: 'photo' | 'video') => number | null;
      };

      const video = videoDocument();
      expect(service.declaredMediaSize({ document: video, video }, 'video')).toBe(1000);
      expect(service.declaredMediaSize({ document: { size: 2048 }, video: undefined }, 'video')).toBe(2048);
      expect(service.declaredMediaSize({ document: { size: BigInt(4096) }, video: undefined }, 'video')).toBe(4096);
      expect(service.declaredMediaSize({ document: { size: BigInt(-1) }, video: undefined }, 'video')).toBeNull();
      expect(service.declaredMediaSize({ document: { size: Number.NaN }, video: undefined }, 'video')).toBeNull();
      expect(service.declaredMediaSize({ document: undefined, video: undefined }, 'video')).toBeNull();
      expect(service.declaredMediaSize({ document: { size: 'x' }, video: undefined }, 'video')).toBeNull();

      const progressive = new Api.PhotoSizeProgressive({
        type: 'w',
        w: 1280,
        h: 1280,
        sizes: [1024, 2048, 4 * 1024 * 1024],
      });
      expect(service.declaredMediaSize({ photo: { sizes: [progressive] } }, 'photo')).toBe(
        4 * 1024 * 1024
      );
      expect(service.declaredMediaSize({ photo: { sizes: [] } }, 'photo')).toBeNull();
      expect(
        service.declaredMediaSize(
          { photo: { sizes: [new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from([]) })] } },
          'photo'
        )
      ).toBeNull();
      expect(
        service.declaredMediaSize(
          { photo: { sizes: [new Api.PhotoSizeProgressive({ type: 'w', w: 1, h: 1, sizes: [] })] } },
          'photo'
        )
      ).toBeNull();
    });
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

  it('нет активного клиента → FAILED no-client (транзиент, попытку не тратит)', async () => {
    const setupData = setup({});
    (setupData.service as never as { parserClient: any }).parserClient.client.mockReturnValue(undefined);

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED, reason: 'no-client' });
    expect(setupData.client.getMessages).not.toHaveBeenCalled();
  });

  it('пустой буфер → FAILED media-download-empty', async () => {
    const setupData = setup({ download: Buffer.alloc(0) });

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  describe('протухший file_reference', () => {
    const expired = (): Error => new Error('400: FILE_REFERENCE_EXPIRED (caused by GetHistoryRequest)');

    it('перечитывает сообщение один раз и скачивает по свежей ссылке', async () => {
      const stale = messageWithPhoto();
      const fresh = messageWithPhoto();
      const getMessages = jest.fn().mockResolvedValueOnce([stale]).mockResolvedValueOnce([fresh]);
      const iterDownload = jest
        .fn()
        .mockImplementationOnce(failingStream(expired()))
        .mockImplementationOnce(() => streamChunks(Buffer.from([9, 9, 9])));
      const { service, bot } = setup({ client: { getMessages, iterDownload } });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: true, status: ObservedStatus.DELIVERED });
      // Ровно одно перечитывание перед вторым скачиванием.
      expect(getMessages).toHaveBeenCalledTimes(2);
      expect(getMessages.mock.calls[1][1]).toEqual({ ids: [42] });
      expect(iterDownload).toHaveBeenCalledTimes(2);
      // `iterDownload` получает TL-локацию: `getFileInfo` не разворачивает Message.
      expect(iterDownload.mock.calls[0][0].file).toBe((stale as any).media);
      expect(iterDownload.mock.calls[1][0].file).toBe((fresh as any).media);
      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);
    });

    it('повтор после перечитывания тоже падает → media-fetch-failed', async () => {
      const getMessages = jest.fn().mockResolvedValue([messageWithPhoto()]);
      const iterDownload = jest.fn(failingStream(expired()));
      const { service } = setup({ client: { getMessages, iterDownload } });
      const row = candidate();

      const result = await service.deliver(row);

      expect(result).toMatchObject({
        ok: false,
        status: ObservedStatus.FAILED,
        reason: 'media-fetch-failed',
      });
      expect(getMessages).toHaveBeenCalledTimes(2);
      expect(iterDownload).toHaveBeenCalledTimes(2);
      expect(row.rejectReason).toBe('media-fetch-failed');
    });

    it('сообщение не резолвится → media-fetch-failed после одного повтора', async () => {
      const getMessages = jest.fn().mockRejectedValue(new Error('CHANNEL_INVALID'));
      const { service, client } = setup({ client: { getMessages } });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: false, reason: 'media-fetch-failed' });
      expect(getMessages).toHaveBeenCalledTimes(2);
      expect(client.downloadMedia).not.toHaveBeenCalled();
      expect(client.iterDownload).not.toHaveBeenCalled();
    });
  });

  describe('флуд-гейт MTProto', () => {
    it('гейт закрыт до доставки → ни одного вызова Telegram', async () => {
      const { service, client, guard } = setup();
      guard.state.blocked = true;

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: false, reason: 'mtproto-blocked' });
      expect(client.getMessages).not.toHaveBeenCalled();
      expect(client.downloadMedia).not.toHaveBeenCalled();
      expect(client.iterDownload).not.toHaveBeenCalled();
    });

    it('пир в бэкоффе (вызова не было) → mtproto-blocked без повтора', async () => {
      const getMessages = jest.fn();
      const { service, guard } = setup({ client: { getMessages } });
      guard.run.mockResolvedValue(undefined); // guard не дёргал Telegram: бэкофф пира

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: false, reason: 'mtproto-blocked' });
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('FLOOD_WAIT на скачивании → без перечитывания (попытка не тратится)', async () => {
      const getMessages = jest.fn().mockResolvedValue([messageWithPhoto()]);
      const iterDownload = jest.fn(async function* () {
        if (!guard.state.blocked) {
          guard.state.blocked = true; // как настоящий guard после FloodWait
          throw new Error('420: FLOOD_WAIT_60');
        }
        yield Buffer.alloc(0);
      });
      const { service, guard } = setup({ client: { getMessages, iterDownload } });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: false, reason: 'flood-wait' });
      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(iterDownload).toHaveBeenCalledTimes(1);
    });

    it('гейт закрылся между попытками → перечитывания нет', async () => {
      const getMessages = jest.fn().mockResolvedValue([messageWithPhoto()]);
      const iterDownload = jest.fn(async function* () {
        if (!guard.state.blocked) {
          guard.state.blocked = true; // паузу поставил параллельный цикл
          throw new Error('400: FILE_REFERENCE_EXPIRED');
        }
        yield Buffer.alloc(0);
      });
      const { service, guard } = setup({ client: { getMessages, iterDownload } });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: false, reason: 'mtproto-blocked' });
      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(iterDownload).toHaveBeenCalledTimes(1);
    });

    it('сетевой сбой транзиентен и не считается медиа-попыткой', async () => {
      const getMessages = jest.fn().mockResolvedValue([messageWithPhoto()]);
      const iterDownload = jest.fn(failingStream(new Error('read ECONNRESET')));
      const { service } = setup({ client: { getMessages, iterDownload } });

      const result = await service.deliver(candidate());

      expect(result).toMatchObject({ ok: false, reason: 'network' });
      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(iterDownload).toHaveBeenCalledTimes(1);
    });
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

    it('buildExtraSourceLink: без username — внутренняя ссылка или имя', () => {
    const { service } = setup({});
    const withChat = service.buildExtraSourceLink({ chatId: '-1001234567890', title: 'Канал', username: null });
    expect(withChat).toContain('https://t.me/c/1234567890');
    const noLink = service.buildExtraSourceLink({ chatId: '0', title: 'Без ссылки', username: null });
    expect(noLink).toBe('Без ссылки');
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
      // Нечисловой chatId — без битой ссылки, только имя.
      expect(
        service.buildExtraSourceLink({ chatId: 'not-a-number', title: null, username: null })
      ).toBe('источник');
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
      const pick = (b: any) => ({ text: b.text, callback_data: b.callback_data, style: b.style });
      expect(keyboard.inline_keyboard[0].map(pick)).toEqual([
        { text: '▶️ Сейчас', callback_data: 'prs:now:7', style: 'success' },
        { text: '📋 В очередь', callback_data: 'prs:q:7', style: 'primary' },
      ]);
      expect(keyboard.inline_keyboard[1].map(pick)).toEqual([
        { text: '🌙 В ночь (кринж)', callback_data: 'prs:night:7', style: 'primary' },
        { text: '🗑 Отклонить', callback_data: 'prs:rej:7', style: 'danger' },
      ]);
      expect(keyboard.inline_keyboard[2].map(pick)).toEqual([
        { text: '🚫 Исключить источник', callback_data: 'prs:excl:7', style: 'danger' },
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

    it('buildUnscheduleConfirmKeyboard', () => {
      const { service } = setup();
      const keyboard = service.buildUnscheduleConfirmKeyboard(7) as unknown as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(
        keyboard.inline_keyboard
          .flat()
          .map((b: any) => ({ text: b.text, callback_data: b.callback_data, style: b.style }))
      ).toEqual([
        { text: '✅ Снять с публикации', callback_data: 'prs:unschedok:7', style: 'danger' },
        { text: '↩️ Отмена', callback_data: 'prs:unschedno:7', style: undefined },
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
    // Основное видео идёт bounded-путём; `downloadMedia` здесь — только обложка.
    (client.downloadMedia as jest.Mock).mockResolvedValue(null);

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
