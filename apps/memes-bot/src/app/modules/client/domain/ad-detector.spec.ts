import { Logger } from '@nestjs/common';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { AdDetectionPorts, AdDetector, ResolvedChannelEntity } from './ad-detector';

function urlEntity(offset: number, length: number) {
  return new Api.MessageEntityUrl({ offset, length });
}

function textUrlEntity(url: string) {
  return new Api.MessageEntityTextUrl({ offset: 0, length: 1, url });
}

function apiDocument(mimeType: string) {
  const document = new Api.Document({
    id: bigInt(1) as any,
    accessHash: bigInt(1) as any,
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType,
    size: bigInt(1) as any,
    dcId: 1,
    attributes: [],
  });
  return new Api.MessageMediaDocument({ document });
}

function makePorts(overrides: Partial<AdDetectionPorts> = {}): AdDetectionPorts {
  return {
    isPostWithLinks: jest.fn().mockResolvedValue(true),
    extractUrls: jest.fn().mockResolvedValue(['https://t.me/x']),
    resolveUrl: jest.fn().mockResolvedValue({ id: bigInt(1) }),
    isSameChannel: jest.fn().mockReturnValue(false),
    getCurrentChannel: jest.fn().mockResolvedValue({ id: bigInt(1) }),
    ...overrides,
  };
}

describe('AdDetector', () => {
  const detector = new AdDetector();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('hasMediaContent', () => {
    it('распознаёт фото и видео', () => {
      expect(detector.hasMediaContent({ photo: {} } as any)).toBe(true);
      expect(detector.hasMediaContent({ video: {} } as any)).toBe(true);
    });

    it('распознаёт media-photo и видео-документ', () => {
      expect(detector.hasMediaContent({ media: new Api.MessageMediaPhoto({} as any) } as any)).toBe(
        true
      );
      expect(detector.hasMediaContent({ media: apiDocument('video/mp4') } as any)).toBe(true);
    });

    it('не считает медиа не-видео документ', () => {
      expect(detector.hasMediaContent({ media: apiDocument('image/png') } as any)).toBe(false);
      expect(
        detector.hasMediaContent({ media: new Api.MessageMediaDocument({ document: {} } as any) } as any)
      ).toBe(false);
      expect(detector.hasMediaContent({ media: {} } as any)).toBe(false);
      expect(detector.hasMediaContent({} as any)).toBe(false);
    });
  });

  describe('isPostWithLinks', () => {
    it('false без caption и события', async () => {
      await expect(detector.isPostWithLinks({ message: {} } as any)).resolves.toBe(false);
      await expect(detector.isPostWithLinks({} as any)).resolves.toBe(false);
      await expect(detector.isPostWithLinks(undefined as any)).resolves.toBe(false);
    });

    it('true для MessageEntityUrl', async () => {
      await expect(
        detector.isPostWithLinks({ message: { message: 'x', entities: [urlEntity(0, 1)] } } as any)
      ).resolves.toBe(true);
    });

    it('true для MessageEntityTextUrl', async () => {
      await expect(
        detector.isPostWithLinks({
          message: { message: 'x', entities: [textUrlEntity('https://t.me/y')] },
        } as any)
      ).resolves.toBe(true);
    });

    it('false для сущностей без ссылок', async () => {
      await expect(
        detector.isPostWithLinks({ message: { message: 'x', entities: [{}] } } as any)
      ).resolves.toBe(false);
    });
  });

  describe('extractUrls', () => {
    it('возвращает пустой список без сущностей', async () => {
      await expect(detector.extractUrls({ message: {} } as any)).resolves.toEqual([]);
    });

    it('извлекает Url и TextUrl', async () => {
      await expect(
        detector.extractUrls({
          message: {
            message: 'go https://site.ru now',
            entities: [urlEntity(3, 15), textUrlEntity('https://t.me/hidden'), {}],
          },
        } as any)
      ).resolves.toEqual(['https://site.ru', 'https://t.me/hidden']);
    });
  });

  describe('resolveUrl', () => {
    it('раскрывает короткую t.me и вызывает getEntity', async () => {
      const getEntity = jest.fn().mockResolvedValue({ id: bigInt(5) });
      await expect(detector.resolveUrl('t.me/somechannel', { getEntity })).resolves.toEqual({
        id: bigInt(5),
      });
      expect(getEntity).toHaveBeenCalledWith('somechannel');
    });

    it('берёт username из полной t.me-ссылки с путём', async () => {
      const getEntity = jest.fn().mockResolvedValue({ id: bigInt(5) });
      await detector.resolveUrl('https://t.me/channel/123', { getEntity });
      expect(getEntity).toHaveBeenCalledWith('channel');
    });

    it('помечает не-Telegram ссылку внешней', async () => {
      const getEntity = jest.fn();
      await expect(detector.resolveUrl('https://example.com/x', { getEntity })).resolves.toEqual({
        isExternal: true,
        url: 'https://example.com/x',
      });
      expect(getEntity).not.toHaveBeenCalled();
    });
  });

  describe('isSameChannel', () => {
    it('внешний URL всегда другой канал', () => {
      expect(detector.isSameChannel({ isExternal: true }, { id: bigInt(1) })).toBe(false);
    });

    it('сравнивает id', () => {
      expect(detector.isSameChannel({ id: bigInt(1) }, { id: bigInt(1) })).toBe(true);
      expect(detector.isSameChannel({ id: bigInt(1) }, { id: bigInt(2) })).toBe(false);
    });

    it('сравнивает username без учёта регистра', () => {
      expect(detector.isSameChannel({ username: 'Channel' }, { username: 'channel' })).toBe(true);
      expect(detector.isSameChannel({ username: 'a' }, { username: 'b' })).toBe(false);
    });

    it('сравнивает username, если у одного канала нет id', () => {
      expect(
        detector.isSameChannel({ id: bigInt(1), username: 'a' }, { username: 'a' } as any)
      ).toBe(true);
    });

    it('false, если сравнивать нечего', () => {
      expect(detector.isSameChannel({}, {})).toBe(false);
    });
  });

  describe('isAdPost', () => {
    const event = { chatId: bigInt(-1), message: { message: 'x' } } as any;

    it('false, если ссылок нет', async () => {
      const ports = makePorts({ isPostWithLinks: jest.fn().mockResolvedValue(false) });
      await expect(detector.isAdPost(event, ports)).resolves.toBe(false);
    });

    it('false, если текст пуст', async () => {
      const ports = makePorts();
      await expect(detector.isAdPost({ message: {} } as any, ports)).resolves.toBe(false);
    });

    it('false, если URL не извлечены', async () => {
      const ports = makePorts({ extractUrls: jest.fn().mockResolvedValue([]) });
      await expect(detector.isAdPost(event, ports)).resolves.toBe(false);
    });

    it('true, если ссылка ведёт на другой канал', async () => {
      const ports = makePorts({ isSameChannel: jest.fn().mockReturnValue(false) });
      await expect(detector.isAdPost(event, ports)).resolves.toBe(true);
    });

    it('false, если все ссылки ведут на текущий канал', async () => {
      const ports = makePorts({ isSameChannel: jest.fn().mockReturnValue(true) });
      await expect(detector.isAdPost(event, ports)).resolves.toBe(false);
    });

    it('true после проверки нескольких ссылок, если одна чужая', async () => {
      const isSameChannel = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
      const ports = makePorts({
        extractUrls: jest.fn().mockResolvedValue(['https://t.me/a', 'https://t.me/b']),
        isSameChannel,
      });

      await expect(detector.isAdPost(event, ports)).resolves.toBe(true);
      expect(isSameChannel).toHaveBeenCalledTimes(2);
    });

    it('true и логирует ошибку разрешения ссылки', async () => {
      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const ports = makePorts({
        resolveUrl: jest.fn().mockRejectedValue(new Error('nope')),
        loggerContext: 'TestContext',
      });

      await expect(detector.isAdPost(event, ports)).resolves.toBe(true);
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error resolving URL'),
        'TestContext'
      );
    });

    it('использует имя класса, если контекст логгера не передан', async () => {
      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const ports = makePorts({ resolveUrl: jest.fn().mockRejectedValue(new Error('nope')) });

      await detector.isAdPost(event, ports);
      expect(loggerSpy).toHaveBeenCalledWith(expect.any(String), AdDetector.name);
    });

    it('обращается к текущему каналу через порт', async () => {
      const ports = makePorts({
        getCurrentChannel: jest.fn().mockResolvedValue({ id: bigInt(7) } as ResolvedChannelEntity),
      });
      await detector.isAdPost(event, ports);
      expect(ports.getCurrentChannel).toHaveBeenCalledWith(event.chatId);
    });
  });
});
