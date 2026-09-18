import { Logger, StreamableFile } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of } from 'rxjs';
import { Repository } from 'typeorm';

const mockS3Send = jest.fn();
const mockHttpsGet = jest.fn();
const mockHttpGet = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: any) => ({ input })),
  GetObjectCommand: jest.fn((input: any) => ({ input })),
}));

import { E2EHarness, createE2EHarness } from './harness';
import { Bot } from 'grammy';
import axios from 'axios';
import * as FormData from 'form-data';
import * as http from 'http';
import * as https from 'https';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BaseConfigService } from '../../src/app/modules/config/base-config.service';
import { MemesController } from '../../src/app/modules/channel-monitor/controllers/memes.controller';
import { ChannelMemeEntity } from '../../src/app/modules/channel-monitor/entities/channel-meme.entity';
import { ChannelMonitorBotService } from '../../src/app/modules/channel-monitor/services/channel-monitor-bot.service';
import { MattermostService } from '../../src/app/modules/mattermost/mattermost.service';
import { MemeUploadService } from '../../src/app/modules/s3/services/meme-upload.service';
import { S3Service } from '../../src/app/modules/s3/services/s3.service';

const MAIN_CHANNEL = process.env.MANAGED_CHANNEL!;
const BEST_CHANNEL = process.env.BEST_MANAGED_CHANNEL!;
const MAIN_CHANNEL_ID = Number(MAIN_CHANNEL);
const BEST_CHANNEL_ID = Number(BEST_CHANNEL);

const s3Config: any = {
  s3Bucket: process.env.S3_BUCKET,
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: process.env.S3_REGION,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  memeChanelId: MAIN_CHANNEL_ID,
  bestMemeChanelId: BEST_CHANNEL_ID,
  botToken: process.env.BOT_TOKEN,
  tgEnv: 'test',
};

const mattermostConfig: any = {
  mattermostBaseUrl: 'https://mm.test',
  mattermostToken: 'token-123',
  mattermostChannelId: 'channel-42',
};

const flushMicro = async (): Promise<void> => {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
};

function makeResponse(): any {
  return { set: jest.fn() };
}

async function seedMeme(
  h: E2EHarness,
  options: {
    channelType: 'main' | 'best';
    messageId?: number;
    s3Key?: string;
    createdAt?: Date;
    caption?: string | null;
  }
): Promise<void> {
  await h.dataSource.query(
    `INSERT INTO channel_memes
       ("channelId", "channelType", "messageId", "s3Key", "caption", "fileId", "fileSize", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      options.channelType === 'main' ? MAIN_CHANNEL : BEST_CHANNEL,
      options.channelType,
      options.messageId ?? 1,
      options.s3Key ?? `channel-memes/${options.channelType}/1.jpg`,
      options.caption ?? null,
      'file-1',
      128,
      options.createdAt ?? new Date(),
    ]
  );
}

function stubDownload(chunks: Buffer[] = [Buffer.from('image')], statusCode = 200) {
  const response: any = { statusCode };
  response.on = jest.fn((event: string, handler: (arg?: any) => void) => {
    if (event === 'data') {
      chunks.forEach((chunk) => handler(chunk));
    }
    if (event === 'end') {
      handler();
    }
    return response;
  });
  const request: any = { on: jest.fn(() => request) };
  mockHttpsGet.mockImplementationOnce((_url: string, callback: (res: any) => void) => {
    callback(response);
    return request;
  });
  return { response, request };
}

describe('E2E: channel-monitor, s3/meme-upload и mattermost', () => {
  describe('MemesController (реальный сервис + Postgres)', () => {
    let h: E2EHarness;
    let repo: Repository<ChannelMemeEntity>;
    let controller: MemesController;

    beforeAll(async () => {
      h = await createE2EHarness();
    });

    afterAll(async () => {
      await h.close();
    });

    beforeEach(async () => {
      await h.resetDb();
      mockS3Send.mockReset();
      repo = h.dataSource.getRepository(ChannelMemeEntity);
      const moduleRef = await Test.createTestingModule({
        providers: [
          MemesController,
          ChannelMonitorBotService,
          S3Service,
          { provide: BaseConfigService, useValue: h.moduleRef.get(BaseConfigService) },
          { provide: getRepositoryToken(ChannelMemeEntity), useValue: repo },
        ],
      }).compile();
      controller = moduleRef.get(MemesController);
      (S3Client as unknown as jest.Mock).mockClear();
      (GetObjectCommand as unknown as jest.Mock).mockClear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('main/last отдаёт новейший мем и заголовки с ETag из id', async () => {
      await seedMeme(h, {
        channelType: 'main',
        messageId: 9,
        s3Key: 'channel-memes/main/9.jpg',
        createdAt: new Date('2024-02-01'),
      });
      const lastModified = new Date('2026-09-01T12:00:00.000Z');
      mockS3Send.mockResolvedValueOnce({
        Body: 'stream',
        ContentType: 'image/png',
        ContentLength: 1234,
        LastModified: lastModified,
      });

      const res = makeResponse();
      const result = await controller.getLastMainMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: process.env.S3_BUCKET,
        Key: 'channel-memes/main/9.jpg',
      });
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'image/png',
          'Content-Length': 1234,
          'Cache-Control': 'public, max-age=3600, must-revalidate',
          'Last-Modified': lastModified.toUTCString(),
        })
      );
      expect(res.set.mock.calls[0][0].ETag).toMatch(/^"\d+"$/);
    });

    it('main/last выбирает более новый createdAt', async () => {
      await seedMeme(h, {
        channelType: 'main',
        messageId: 1,
        s3Key: 'old.jpg',
        createdAt: new Date('2024-01-01'),
      });
      await seedMeme(h, {
        channelType: 'main',
        messageId: 2,
        s3Key: 'new.jpg',
        createdAt: new Date('2024-03-01'),
      });
      mockS3Send.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/jpeg' });

      await controller.getLastMainMeme(makeResponse());

      expect(GetObjectCommand).toHaveBeenCalledWith(expect.objectContaining({ Key: 'new.jpg' }));
    });

    it('main/last без мемов отдаёт SVG-placeholder', async () => {
      const res = makeResponse();
      const result = await controller.getLastMainMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(res.set.mock.calls[0][0]).toMatchObject({
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-cache',
      });
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('main/last ошибка S3 превращается в NotFoundException', async () => {
      await seedMeme(h, { channelType: 'main' });
      mockS3Send.mockRejectedValueOnce(new Error('s3 down'));

      await expect(controller.getLastMainMeme(makeResponse())).rejects.toThrow(
        'Failed to load image'
      );
    });

    it('main/last пустой Body превращается в NotFoundException', async () => {
      await seedMeme(h, { channelType: 'main' });
      mockS3Send.mockResolvedValueOnce({ Body: undefined });

      await expect(controller.getLastMainMeme(makeResponse())).rejects.toThrow(
        'Failed to load image'
      );
    });

    it('main/random отдаёт случайный main-мем', async () => {
      await seedMeme(h, { channelType: 'main', s3Key: 'random-main.jpg' });
      mockS3Send.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/webp' });

      const res = makeResponse();
      const result = await controller.getRandomMainMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: 'random-main.jpg' })
      );
      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/webp');
    });

    it('main/random без мемов отдаёт placeholder', async () => {
      const res = makeResponse();
      const result = await controller.getRandomMainMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/svg+xml');
    });

    it('best/last отдаёт последний best-мем', async () => {
      await seedMeme(h, {
        channelType: 'best',
        s3Key: 'best.jpg',
        createdAt: new Date('2024-03-01'),
      });
      mockS3Send.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/gif' });

      const res = makeResponse();
      const result = await controller.getLastBestMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(GetObjectCommand).toHaveBeenCalledWith(expect.objectContaining({ Key: 'best.jpg' }));
    });

    it('best/last падает обратно на main при отсутствии best', async () => {
      await seedMeme(h, { channelType: 'main', s3Key: 'main-fallback.jpg' });
      mockS3Send.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/jpeg' });

      const result = await controller.getLastBestMeme(makeResponse());

      expect(result).toBeInstanceOf(StreamableFile);
      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: 'main-fallback.jpg' })
      );
    });

    it('best/last без мемов отдаёт placeholder', async () => {
      const res = makeResponse();
      const result = await controller.getLastBestMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/svg+xml');
    });

    it('best/random отдаёт случайный best-мем', async () => {
      await seedMeme(h, { channelType: 'best', s3Key: 'rand-best.jpg' });
      mockS3Send.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/png' });

      const result = await controller.getRandomBestMeme(makeResponse());

      expect(result).toBeInstanceOf(StreamableFile);
      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: 'rand-best.jpg' })
      );
    });

    it('best/random падает обратно на main при отсутствии best', async () => {
      await seedMeme(h, { channelType: 'main', s3Key: 'rand-main-fallback.jpg' });
      mockS3Send.mockResolvedValueOnce({ Body: 'stream', ContentType: 'image/jpeg' });

      await controller.getRandomBestMeme(makeResponse());

      expect(GetObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: 'rand-main-fallback.jpg' })
      );
    });

    it('best/random без мемов отдаёт placeholder', async () => {
      const res = makeResponse();
      const result = await controller.getRandomBestMeme(res);

      expect(result).toBeInstanceOf(StreamableFile);
      expect(res.set.mock.calls[0][0]['Content-Type']).toBe('image/svg+xml');
    });
  });

  describe('ChannelMonitorBotService ingestion (реальный сервис + Postgres)', () => {
    let h: E2EHarness;
    let repo: Repository<ChannelMemeEntity>;
    let config: BaseConfigService;
    let handlers: Record<string, (ctx: any) => any>;

    beforeAll(async () => {
      h = await createE2EHarness();
    });

    afterAll(async () => {
      await h.close();
    });

    function makeCtx(
      chatId: number,
      options: { messageId?: number; caption?: string; getFile?: jest.Mock } = {}
    ): any {
      return {
        channelPost: {
          chat: { id: chatId },
          message_id: options.messageId ?? 42,
          caption: options.caption,
          photo: [
            { file_id: 'small', file_size: 10 },
            { file_id: 'file-1', file_size: 2048 },
          ],
        },
        api: {
          getFile: options.getFile ?? jest.fn().mockResolvedValue({ file_path: 'photos/m.jpg' }),
        },
      };
    }

    async function initService(): Promise<ChannelMonitorBotService> {
      const moduleRef = await Test.createTestingModule({
        providers: [
          ChannelMonitorBotService,
          S3Service,
          { provide: BaseConfigService, useValue: config },
          { provide: getRepositoryToken(ChannelMemeEntity), useValue: repo },
        ],
      }).compile();
      const service = moduleRef.get(ChannelMonitorBotService);
      await service.onModuleInit();
      return service;
    }

    beforeEach(async () => {
      await h.resetDb();
      mockS3Send.mockReset();
      mockS3Send.mockResolvedValue({});
      mockHttpsGet.mockReset();
      jest
        .spyOn(https as any, 'get')
        .mockImplementation((...args: any[]) => mockHttpsGet(...args));
      jest.spyOn(http as any, 'get').mockImplementation((...args: any[]) => mockHttpGet(...args));
      handlers = {};
      (PutObjectCommand as unknown as jest.Mock).mockClear();

      config = h.moduleRef.get(BaseConfigService);
      repo = h.dataSource.getRepository(ChannelMemeEntity);

      jest
        .spyOn(Bot.prototype as any, 'on')
        .mockImplementation(function (this: any, event: string, handler: any) {
          handlers[event] = handler;
          return this;
        });
      jest.spyOn(Bot.prototype as any, 'start').mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('сохраняет main-мем и обновляет last-meme', async () => {
      stubDownload([Buffer.from('image-bytes')]);
      const service = await initService();

      await handlers['channel_post:photo'](makeCtx(MAIN_CHANNEL_ID, { caption: 'подпись' }));

      const saved = await repo.findOne({ where: { channelType: 'main' } });
      expect(saved).toBeTruthy();
      expect(saved!.s3Key).toMatch(/^channel-memes\/main\/\d+-42\.jpg$/);
      expect(saved!.caption).toBe('подпись');
      expect(saved!.channelId).toBe(MAIN_CHANNEL);
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: process.env.S3_BUCKET,
          Key: 'last-meme/meme.img',
          Body: Buffer.from('image-bytes'),
          ContentType: 'image/jpeg',
        })
      );
      await expect(service.getLastMeme()).resolves.toMatchObject({ channelType: 'main' });
    });

    it('сохраняет best-мем и обновляет best-meme', async () => {
      stubDownload([Buffer.from('best-bytes')]);
      await initService();

      await handlers['channel_post:photo'](makeCtx(BEST_CHANNEL_ID, { messageId: 43 }));

      const saved = await repo.findOne({ where: { channelType: 'best' } });
      expect(saved).toBeTruthy();
      expect(saved!.s3Key).toMatch(/^channel-memes\/best\/\d+-43\.jpg$/);
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Key: 'best-meme/first.img', Body: Buffer.from('best-bytes') })
      );
    });

    it('в test-окружении скачивает файл по /test/ URL', async () => {
      stubDownload();
      await initService();

      await handlers['channel_post:photo'](makeCtx(MAIN_CHANNEL_ID));

      expect(mockHttpsGet).toHaveBeenCalledWith(
        expect.stringContaining('/test/photos/m.jpg'),
        expect.any(Function)
      );
    });

    it('игнорирует неизвестный канал', async () => {
      await initService();

      await handlers['channel_post:photo'](makeCtx(-100999999));

      expect(await repo.count()).toBe(0);
      expect(mockHttpsGet).not.toHaveBeenCalled();
    });

    it('не сохраняет мем при ошибке скачивания (не 200)', async () => {
      stubDownload([], 404);
      await initService();

      await handlers['channel_post:photo'](makeCtx(MAIN_CHANNEL_ID));

      expect(await repo.count()).toBe(0);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('не сохраняет и не падает, если Telegram getFile упал', async () => {
      await initService();
      const ctx = makeCtx(MAIN_CHANNEL_ID, {
        getFile: jest.fn().mockRejectedValue(new Error('tg down')),
      });

      await expect(handlers['channel_post:photo'](ctx)).resolves.toBeUndefined();
      expect(await repo.count()).toBe(0);
    });

    it('игнорирует сообщение без фото', async () => {
      await initService();

      await handlers['channel_post:photo']({
        channelPost: { chat: { id: MAIN_CHANNEL_ID }, photo: undefined },
        api: { getFile: jest.fn() },
      });

      expect(await repo.count()).toBe(0);
    });

    it('getLastBestMeme и getRandomMemeByType читают сохранённые мемы', async () => {
      stubDownload();
      const service = await initService();

      await handlers['channel_post:photo'](makeCtx(MAIN_CHANNEL_ID, { messageId: 1 }));
      stubDownload();
      await handlers['channel_post:photo'](makeCtx(BEST_CHANNEL_ID, { messageId: 2 }));

      await expect(service.getLastBestMeme()).resolves.toMatchObject({ channelType: 'best' });
      await expect(service.getRandomMemeByType('main')).resolves.toMatchObject({
        channelType: 'main',
      });
      await expect(service.getRandomMemeByType('best')).resolves.toMatchObject({
        channelType: 'best',
      });
    });

    it('пустая база: getLastMeme/getLastBestMeme/getRandomMemeByType дают null', async () => {
      const service = await initService();

      await expect(service.getLastMeme()).resolves.toBeNull();
      await expect(service.getLastBestMeme()).resolves.toBeNull();
      await expect(service.getRandomMemeByType('main')).resolves.toBeNull();
    });
  });

  describe('S3Service / MemeUploadService (мок AWS SDK и http)', () => {
    function makeHttpMock(): any {
      return { get: jest.fn().mockReturnValue(of({ data: new Uint8Array([1, 2, 3]) })) };
    }

    function makeUpload(overrides: () => any = makeHttpMock) {
      const httpMock = overrides();
      const s3 = new S3Service(s3Config);
      const upload = new MemeUploadService(s3, s3Config, httpMock as any);
      return { s3, upload, httpMock };
    }

    function uploadCtx(chatId: number, filePath = 'photos/m.jpg'): any {
      return {
        channelPost: { chat: { id: chatId }, photo: [{ file_id: 'file-1' }] },
        api: { getFile: jest.fn().mockResolvedValue({ file_path: filePath }) },
      };
    }

    beforeEach(() => {
      mockS3Send.mockReset();
      mockS3Send.mockResolvedValue({});
      mockHttpsGet.mockReset();
      mockHttpGet.mockReset();
      jest
        .spyOn(https as any, 'get')
        .mockImplementation((...args: any[]) => mockHttpsGet(...args));
      jest.spyOn(http as any, 'get').mockImplementation((...args: any[]) => mockHttpGet(...args));
      (PutObjectCommand as unknown as jest.Mock).mockClear();
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('handleChannelPost загружает main-мем в S3', async () => {
      const { upload, httpMock } = makeUpload();

      await upload.handleChannelPost(uploadCtx(MAIN_CHANNEL_ID));

      expect(httpMock.get).toHaveBeenCalledWith(
        expect.stringContaining('/test/photos/m.jpg'),
        { responseType: 'arraybuffer' }
      );
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'last-meme/meme.img',
          Body: Buffer.from([1, 2, 3]),
          ContentType: 'image/jpeg',
        })
      );
      expect(mockS3Send).toHaveBeenCalledTimes(1);
    });

    it('предупреждает и выходит без сообщения', async () => {
      const { upload } = makeUpload();

      await upload.handleChannelPost({} as any);

      expect(Logger.prototype.warn).toHaveBeenCalledWith('No message found in context');
    });

    it('предупреждает о неизвестном канале', async () => {
      const { upload } = makeUpload();

      await upload.handleChannelPost(uploadCtx(-999));

      expect(Logger.prototype.warn).toHaveBeenCalledWith('Unknown channel ID: -999');
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('буферизует best-мемы и загружает их через 60 секунд (debounce)', async () => {
      jest.useFakeTimers();
      const { upload } = makeUpload();

      await upload.handleChannelPost(uploadCtx(BEST_CHANNEL_ID));
      await upload.handleChannelPost(uploadCtx(BEST_CHANNEL_ID));

      expect((upload as any).bestMemesBuffer).toHaveLength(2);
      expect(mockS3Send).not.toHaveBeenCalled();

      jest.advanceTimersByTime(60000);
      await flushMicro();

      const keys = (PutObjectCommand as unknown as jest.Mock).mock.calls.map((call) => call[0].Key);
      expect(keys).toEqual(['best-meme/first.img', 'best-meme/second.img']);
      expect((upload as any).bestMemesBuffer).toEqual([]);
      expect((upload as any).bestMemesTimer).toBeNull();
    });

    it('uploadBufferedBestMemes грузит не более двух мемов', async () => {
      const { upload } = makeUpload();
      (upload as any).bestMemesBuffer = [
        Buffer.from('a'),
        Buffer.from('b'),
        Buffer.from('c'),
      ];

      await (upload as any).uploadBufferedBestMemes();

      expect(mockS3Send).toHaveBeenCalledTimes(2);
      expect((upload as any).bestMemesBuffer).toEqual([]);
    });

    it('uploadBufferedBestMemes ничего не делает при пустом буфере', async () => {
      const { upload } = makeUpload();

      await (upload as any).uploadBufferedBestMemes();

      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('uploadBufferedBestMemes логирует ошибку S3 и очищает буфер', async () => {
      const { upload } = makeUpload();
      (upload as any).bestMemesBuffer = [Buffer.from('a')];
      mockS3Send.mockRejectedValueOnce(new Error('s3 down'));

      await (upload as any).uploadBufferedBestMemes();

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to upload buffered best memes: s3 down'
      );
      expect((upload as any).bestMemesBuffer).toEqual([]);
    });

    it('forceUpdateMemes — no-op, который только логирует', async () => {
      const { upload } = makeUpload();

      await expect(upload.forceUpdateMemes()).resolves.toBeUndefined();

      expect(Logger.prototype.log).toHaveBeenCalledWith('Force updating memes from channels...');
    });

    it('downloadImage склеивает чанки https-ответа', async () => {
      const s3 = new S3Service(s3Config);
      mockHttpsGet.mockImplementationOnce((_url: string, callback: (res: any) => void) => {
        const response: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: (arg?: any) => void) => {
            if (event === 'data') {
              handler(Buffer.from('ab'));
              handler(Buffer.from('cd'));
            }
            if (event === 'end') {
              handler();
            }
            return response;
          }),
        };
        const request: any = { on: jest.fn(() => request) };
        callback(response);
        return request;
      });

      await expect((s3 as any).downloadImage('https://cdn.local/img.jpg')).resolves.toEqual(
        Buffer.from('abcd')
      );
      expect(mockHttpsGet).toHaveBeenCalledWith('https://cdn.local/img.jpg', expect.any(Function));
    });

    it('downloadImage отклоняет промис при статусе не 200', async () => {
      const s3 = new S3Service(s3Config);
      mockHttpsGet.mockImplementationOnce((_url: string, callback: (res: any) => void) => {
        const response: any = { statusCode: 404, on: jest.fn() };
        const request: any = { on: jest.fn(() => request) };
        callback(response);
        return request;
      });

      await expect((s3 as any).downloadImage('https://cdn.local/gone.jpg')).rejects.toThrow(
        'Failed to download image: 404'
      );
    });

    it('downloadImage отклоняет промис при ошибке потока ответа', async () => {
      const s3 = new S3Service(s3Config);
      mockHttpsGet.mockImplementationOnce((_url: string, callback: (res: any) => void) => {
        const response: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: (arg?: any) => void) => {
            if (event === 'error') {
              handler(new Error('stream broken'));
            }
            return response;
          }),
        };
        const request: any = { on: jest.fn(() => request) };
        callback(response);
        return request;
      });

      await expect((s3 as any).downloadImage('https://cdn.local/img.jpg')).rejects.toThrow(
        'stream broken'
      );
    });

    it('downloadImage использует http для не-https ссылки', async () => {
      const s3 = new S3Service(s3Config);
      mockHttpGet.mockImplementationOnce((_url: string, callback: (res: any) => void) => {
        const response: any = {
          statusCode: 200,
          on: jest.fn((event: string, handler: (arg?: any) => void) => {
            if (event === 'data') {
              handler(Buffer.from('xx'));
            }
            if (event === 'end') {
              handler();
            }
            return response;
          }),
        };
        const request: any = { on: jest.fn(() => request) };
        callback(response);
        return request;
      });

      await expect((s3 as any).downloadImage('http://cdn.local/img.jpg')).resolves.toEqual(
        Buffer.from('xx')
      );
      expect(mockHttpGet).toHaveBeenCalled();
      expect(mockHttpsGet).not.toHaveBeenCalled();
    });
  });

  describe('MattermostService (мок axios)', () => {
    let post: jest.Mock;
    let axiosGet: jest.Mock;
    let appendSpy: jest.SpyInstance;

    beforeEach(() => {
      post = jest.fn();
      axiosGet = (axios as any).get as jest.Mock;
      axiosGet.mockReset();
      (axios as any).create.mockReset();
      (axios as any).create.mockReturnValue({ post, get: jest.fn() });
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      appendSpy = jest.spyOn(FormData.prototype as any, 'append');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('создаёт axios-клиент с baseURL и Bearer-токеном', () => {
      new MattermostService(mattermostConfig);

      expect((axios as any).create).toHaveBeenCalledWith({
        baseURL: 'https://mm.test',
        headers: { Authorization: 'Bearer token-123' },
      });
    });

    it('без fileUrl публикует пост с пустым file_ids', async () => {
      post.mockResolvedValueOnce({ data: {} });
      const service = new MattermostService(mattermostConfig);

      await service.sendPostWithFile({ message: 'привет из TG' });

      expect(axiosGet).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'привет из TG',
        file_ids: [],
      });
    });

    it('пустое сообщение заменяется на пустую строку', async () => {
      post.mockResolvedValueOnce({ data: {} });
      const service = new MattermostService(mattermostConfig);

      await service.sendPostWithFile({ message: undefined as any });

      expect(post).toHaveBeenCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: '',
        file_ids: [],
      });
    });

    it('с fileUrl скачивает, загружает файл и прикрепляет file_ids', async () => {
      axiosGet.mockResolvedValueOnce({
        data: Buffer.from('image-bytes'),
        headers: { 'content-type': 'image/png' },
      });
      post
        .mockResolvedValueOnce({ data: { file_infos: [{ id: 'file-1' }, { id: 'file-2' }] } })
        .mockResolvedValueOnce({ data: { id: 'post-1' } });
      const service = new MattermostService(mattermostConfig);

      await service.sendPostWithFile({
        message: 'мем',
        fileUrl: 'https://api.telegram.org/file/botTOKEN/photo.png',
        fileName: 'meme',
      });

      expect(axiosGet).toHaveBeenCalledWith(
        'https://api.telegram.org/file/botTOKEN/photo.png',
        { responseType: 'arraybuffer' }
      );
      expect(post.mock.calls[0][0]).toBe('/api/v4/files');
      expect(post.mock.calls[0][1]).toBeInstanceOf(FormData);
      expect(post).toHaveBeenLastCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'мем',
        file_ids: ['file-1', 'file-2'],
      });
      const filesAppend = appendSpy.mock.calls.find((call) => call[0] === 'files')!;
      expect(filesAppend[1]).toEqual(Buffer.from('image-bytes'));
      expect(filesAppend[2]).toMatchObject({ filename: 'meme.png', contentType: 'image/png' });
    });

    it('расширение берётся из URL, если content-type не подсказывает', async () => {
      axiosGet.mockResolvedValueOnce({
        data: Buffer.from('x'),
        headers: { 'content-type': 'application/octet-stream' },
      });
      post.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: {} });
      const service = new MattermostService(mattermostConfig);

      await service.sendPostWithFile({ message: 'm', fileUrl: 'https://tg/video.mp4' });

      const filesAppend = appendSpy.mock.calls.find((call) => call[0] === 'files')!;
      expect(filesAppend[2]).toMatchObject({ filename: 'meme.mp4' });
    });

    it('ошибка скачивания файла не мешает публикации поста', async () => {
      axiosGet.mockRejectedValueOnce(new Error('network'));
      post.mockResolvedValueOnce({ data: {} });
      const service = new MattermostService(mattermostConfig);

      await service.sendPostWithFile({
        message: 'мем',
        fileUrl: 'https://tg/broken',
        fileName: 'meme',
      });

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to upload file to Mattermost:',
        expect.any(Error)
      );
      expect(post).toHaveBeenCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'мем',
        file_ids: [],
      });
    });

    it('ошибка публикации поста перехватывается и логируется', async () => {
      post.mockRejectedValueOnce(new Error('mm down'));
      const service = new MattermostService(mattermostConfig);

      await expect(service.sendPostWithFile({ message: 'мем' })).resolves.toBeUndefined();

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to send post to Mattermost:',
        expect.any(Error)
      );
    });
  });
});
