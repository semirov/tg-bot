import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ObservedStatus } from '../constants/parser.constants';
import { ParserDeliveryService } from './parser-delivery.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

jest.mock('imghash', () => ({
  hash: jest.fn().mockResolvedValue('abcd1234efgh5678'),
}));

const NOW = new Date('2026-09-19T12:00:00Z');

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

const makeBot = (): any => ({
  api: {
    sendPhoto: jest.fn().mockResolvedValue({ message_id: 5555 }),
    sendVideo: jest.fn().mockResolvedValue({ message_id: 5556 }),
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
  createPublishedPostHash: jest.fn().mockResolvedValue(undefined),
});

const makeClock = (): any => ({ now: jest.fn(() => NOW) });

const setup = (
  overrides: { source?: Record<string, unknown>; download?: unknown; messages?: unknown[] } = {}
) => {
  const observedRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (value) => value),
  };
  const client: Record<string, unknown> = {
    getMessages: jest.fn().mockResolvedValue(overrides.messages ?? [messageWithPhoto()]),
    downloadMedia: jest.fn().mockResolvedValue(overrides.download ?? Buffer.from([1, 2, 3])),
  };
  const service = new ParserDeliveryService(
    makeBot(),
    makeConfig(),
    makeGuard(),
    makeRegistry(overrides.source ?? {}),
    makeParserClient(client),
    makeDedup(),
    observedRepo,
    makeClock()
  );
  return {
    service,
    observedRepo,
    bot: (service as never as { bot: any }).bot,
    dedup: (service as never as { deduplication: any }).deduplication,
    client,
  };
};

describe('ParserDeliveryService', () => {
  it('доставка фото: карточка в предложку со счётчиком источника', async () => {
    const { service, observedRepo, bot, dedup } = setup();
    const row = candidate();

    const result = await service.deliver(row);

    expect(result).toMatchObject({ ok: true });
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
    expect(observedRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ObservedStatus.DELIVERED, deliveredAt: NOW })
    );
    expect(dedup.checkDuplicate).toHaveBeenCalled();
  });

  it('дубль опубликованного → DUPLICATE без отправки', async () => {
    const { service, bot, dedup } = setup();
    dedup.checkDuplicate.mockResolvedValue([{ memePostId: 1, distance: 0.9 }]);

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

  it('видео уходит через sendVideo', async () => {
    const video = new Api.Document({
      id: bigInt('777'),
      accessHash: bigInt('1'),
      fileReference: Buffer.from([]),
      date: 1000,
      attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 640, h: 640 })],
      mimeType: 'video/mp4',
      size: bigInt('1000'),
      dcId: 2,
    });
    const videoMessage = { id: 42, photo: undefined, video, views: 4000 } as unknown as Api.Message;
    const { service, bot } = setup({ messages: [videoMessage] });

    const result = await service.deliver(candidate({ mediaKind: 'video' }));

    expect(result).toMatchObject({ ok: true });
    expect(bot.api.sendVideo).toHaveBeenCalledWith(
      -1004444444444,
      expect.anything(),
      expect.objectContaining({ caption: expect.stringContaining('🧭 Парсер') })
    );
  });

  it('видео больше лимита → FAILED', async () => {
    const video = new Api.Document({
      id: bigInt('777'),
      accessHash: bigInt('1'),
      fileReference: Buffer.from([]),
      date: 1000,
      attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 640, h: 640 })],
      mimeType: 'video/mp4',
      size: bigInt('1000'),
      dcId: 2,
    });
    const videoMessage = { id: 42, photo: undefined, video, views: 4000 } as unknown as Api.Message;
    const { service, bot } = setup({
      messages: [videoMessage],
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

  it('источник отсутствует → FAILED source-missing', async () => {
    const setupData = setup();
    (setupData.service as never as { registry: any }).registry.repository.findOne.mockResolvedValue(null);

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('getMessages не нашёл сообщение → FAILED media-fetch-failed', async () => {
    const setupData = setup({ messages: [] });

    const result = await setupData.service.deliver(candidate());

    expect(result).toMatchObject({ ok: false, status: ObservedStatus.FAILED });
  });

  it('клавиатура карточки — raw inline keyboard', () => {
    const { service } = setup({});
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
  });

  it('подпись карточки: категория, источник, метрики', () => {
    const { service } = setup({});
    const caption = service.buildCaption(candidate(), source());

    expect(caption).toContain('🧭 Парсер');
    expect(caption).toContain('Memes');
    expect(caption).toContain('4.0K');
    expect(caption).toContain('50');
    expect(caption).toContain('4.2');
  });

  it('кринж-категория меняет метку', () => {
    const { service } = setup({ source: { category: 'cringe' } });
    const caption = service.buildCaption(candidate(), source({ category: 'cringe' }));
    expect(caption).toContain('кринж');
  });
});
