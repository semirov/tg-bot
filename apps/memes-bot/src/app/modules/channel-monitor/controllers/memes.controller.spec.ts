import { Logger, NotFoundException, StreamableFile } from '@nestjs/common';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  GetObjectCommand: jest.fn((input: any) => ({ input })),
}));

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MemesController } from './memes.controller';
import { ChannelMemeEntity } from '../entities/channel-meme.entity';

function makeConfig(): any {
  return {
    s3Endpoint: 'https://s3.test',
    s3Region: 'ru-central1',
    s3AccessKeyId: 'key-id',
    s3SecretAccessKey: 'secret',
    s3Bucket: 'memes-bucket',
  };
}

function makeMeme(overrides: Partial<ChannelMemeEntity> = {}): ChannelMemeEntity {
  return Object.assign(new ChannelMemeEntity(), {
    id: 5,
    s3Key: 'channel-memes/main/5.jpg',
    ...overrides,
  });
}

function makeResponse(): any {
  return { set: jest.fn() };
}

function makeService(overrides: Record<string, unknown> = {}): any {
  return {
    getLastMeme: jest.fn(),
    getRandomMemeByType: jest.fn(),
    getLastBestMeme: jest.fn(),
    ...overrides,
  };
}

describe('MemesController', () => {
  beforeEach(() => {
    mockSend.mockReset();
    (S3Client as unknown as jest.Mock).mockClear();
    (GetObjectCommand as unknown as jest.Mock).mockClear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('конструктор', () => {
    it('создаёт S3-клиент с параметрами из конфига', () => {
      new MemesController(makeService(), makeConfig());

      expect((S3Client as unknown as jest.Mock)).toHaveBeenCalledWith({
        endpoint: 'https://s3.test',
        region: 'ru-central1',
        credentials: { accessKeyId: 'key-id', secretAccessKey: 'secret' },
      });
      expect(S3Client).toBeDefined();
    });
  });

  describe('GET /memes/main/last', () => {
    it('логирует запрос и отдаёт последний мем из S3 с заголовками', async () => {
      const lastModified = new Date('2026-09-01T12:00:00.000Z');
      mockSend.mockResolvedValueOnce({
        Body: 'image-stream',
        ContentType: 'image/png',
        ContentLength: 1234,
        LastModified: lastModified,
      });
      const service = makeService({
        getLastMeme: jest.fn().mockResolvedValue(makeMeme({ id: 9 })),
      });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getLastMainMeme(res);

      expect(Logger.prototype.log).toHaveBeenCalledWith('GET /memes/main/last');
      expect((GetObjectCommand as unknown as jest.Mock)).toHaveBeenCalledWith({
        Bucket: 'memes-bucket',
        Key: 'channel-memes/main/5.jpg',
      });
      expect(res.set).toHaveBeenCalledWith({
        'Content-Type': 'image/png',
        'Content-Length': 1234,
        'Cache-Control': 'public, max-age=3600, must-revalidate',
        ETag: '"9"',
        'Last-Modified': lastModified.toUTCString(),
      });
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('при отсутствии мема отдаёт SVG-placeholder', async () => {
      const service = makeService({ getLastMeme: jest.fn().mockResolvedValue(null) });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getLastMainMeme(res);

      expect(Logger.prototype.log).toHaveBeenCalledWith('Returning placeholder image');
      expect(mockSend).not.toHaveBeenCalled();
      const setArg = res.set.mock.calls[0][0];
      expect(setArg['Content-Type']).toBe('image/svg+xml');
      expect(setArg['Cache-Control']).toBe('no-cache');
      expect(setArg['Content-Length']).toBeGreaterThan(0);
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('подставляет image/jpeg и текущую дату, если S3 не вернул ContentType/LastModified', async () => {
      mockSend.mockResolvedValueOnce({ Body: 'stream' });
      const service = makeService({
        getLastMeme: jest.fn().mockResolvedValue(makeMeme({ id: 1 })),
      });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      await controller.getLastMainMeme(res);

      const headers = res.set.mock.calls[0][0];
      expect(headers['Content-Type']).toBe('image/jpeg');
      expect(headers['Content-Length']).toBeUndefined();
      expect(headers.ETag).toBe('"1"');
      expect(typeof headers['Last-Modified']).toBe('string');
    });

    it('пустой Body от S3 превращается в NotFoundException', async () => {
      mockSend.mockResolvedValueOnce({ Body: undefined });
      const service = makeService({
        getLastMeme: jest.fn().mockResolvedValue(makeMeme()),
      });
      const controller = new MemesController(service, makeConfig());

      await expect(controller.getLastMainMeme(makeResponse())).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to stream image from S3: channel-memes/main/5.jpg',
        expect.any(NotFoundException)
      );
    });

    it('ошибка S3 превращается в NotFoundException "Failed to load image"', async () => {
      mockSend.mockRejectedValueOnce(new Error('s3 down'));
      const service = makeService({
        getLastMeme: jest.fn().mockResolvedValue(makeMeme()),
      });
      const controller = new MemesController(service, makeConfig());

      await expect(controller.getLastMainMeme(makeResponse())).rejects.toThrow(
        'Failed to load image'
      );
    });
  });

  describe('GET /memes/main/random', () => {
    it('отдаёт случайный мем основного канала', async () => {
      mockSend.mockResolvedValueOnce({
        Body: 'stream',
        ContentType: 'image/webp',
        ContentLength: 10,
        LastModified: new Date('2026-09-02T00:00:00.000Z'),
      });
      const service = makeService({
        getRandomMemeByType: jest.fn().mockResolvedValue(makeMeme({ id: 11 })),
      });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getRandomMainMeme(res);

      expect(Logger.prototype.log).toHaveBeenCalledWith('GET /memes/main/random');
      expect(service.getRandomMemeByType).toHaveBeenCalledWith('main');
      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/webp');
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('без мема отдаёт placeholder', async () => {
      const service = makeService({ getRandomMemeByType: jest.fn().mockResolvedValue(null) });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getRandomMainMeme(res);

      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/svg+xml');
      expect(result).toBeInstanceOf(StreamableFile);
    });
  });

  describe('GET /memes/best/last', () => {
    it('отдаёт последний мем лучшего канала', async () => {
      mockSend.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/gif' });
      const getLastMeme = jest.fn();
      const service = makeService({
        getLastBestMeme: jest.fn().mockResolvedValue(makeMeme({ id: 20, s3Key: 'best/20.gif' })),
        getLastMeme,
      });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getLastBestMeme(res);

      expect(Logger.prototype.log).toHaveBeenCalledWith('GET /memes/best/last');
      expect(getLastMeme).not.toHaveBeenCalled();
      expect((GetObjectCommand as unknown as jest.Mock)).toHaveBeenCalledWith({
        Bucket: 'memes-bucket',
        Key: 'best/20.gif',
      });
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('при отсутствии лучшего мема падает обратно на основной канал', async () => {
      mockSend.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/jpeg' });
      const getLastMeme = jest.fn().mockResolvedValue(makeMeme({ id: 3, s3Key: 'main/3.jpg' }));
      const service = makeService({
        getLastBestMeme: jest.fn().mockResolvedValue(null),
        getLastMeme,
      });
      const controller = new MemesController(service, makeConfig());

      const result = await controller.getLastBestMeme(makeResponse());

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'No best meme found, falling back to main channel'
      );
      expect(getLastMeme).toHaveBeenCalledTimes(1);
      expect((GetObjectCommand as unknown as jest.Mock)).toHaveBeenCalledWith({ Bucket: 'memes-bucket', Key: 'main/3.jpg' });
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('если нет ни лучшего, ни основного мема — placeholder', async () => {
      const service = makeService({
        getLastBestMeme: jest.fn().mockResolvedValue(null),
        getLastMeme: jest.fn().mockResolvedValue(null),
      });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getLastBestMeme(res);

      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/svg+xml');
      expect(result).toBeInstanceOf(StreamableFile);
    });
  });

  describe('GET /memes/best/random', () => {
    it('отдаёт случайный мем лучшего канала', async () => {
      mockSend.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/png' });
      const getRandomMemeByType = jest
        .fn()
        .mockResolvedValue(makeMeme({ id: 30, s3Key: 'best/30.png' }));
      const service = makeService({ getRandomMemeByType });
      const controller = new MemesController(service, makeConfig());

      const result = await controller.getRandomBestMeme(makeResponse());

      expect(Logger.prototype.log).toHaveBeenCalledWith('GET /memes/best/random');
      expect(getRandomMemeByType).toHaveBeenCalledWith('best');
      expect((GetObjectCommand as unknown as jest.Mock)).toHaveBeenCalledWith({ Bucket: 'memes-bucket', Key: 'best/30.png' });
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('при отсутствии лучшего мема падает обратно на случайный из основного', async () => {
      mockSend.mockResolvedValueOnce({ Body: 'stream' });
      const getRandomMemeByType = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeMeme({ id: 31, s3Key: 'main/31.jpg' }));
      const service = makeService({ getRandomMemeByType });
      const controller = new MemesController(service, makeConfig());

      const result = await controller.getRandomBestMeme(makeResponse());

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'No best meme found, falling back to main channel'
      );
      expect(getRandomMemeByType).toHaveBeenNthCalledWith(1, 'best');
      expect(getRandomMemeByType).toHaveBeenNthCalledWith(2, 'main');
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('если нет мемов ни в одном из каналов — placeholder', async () => {
      const getRandomMemeByType = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const service = makeService({ getRandomMemeByType });
      const controller = new MemesController(service, makeConfig());
      const res = makeResponse();

      const result = await controller.getRandomBestMeme(res);

      expect(getRandomMemeByType).toHaveBeenCalledTimes(2);
      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/svg+xml');
      expect(result).toBeInstanceOf(StreamableFile);
    });
  });
});
