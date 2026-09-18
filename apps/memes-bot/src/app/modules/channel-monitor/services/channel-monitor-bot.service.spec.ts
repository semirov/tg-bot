import { Logger } from '@nestjs/common';

const mockOn = jest.fn();
const mockStart = jest.fn();
const mockS3Send = jest.fn();
const mockHttpsGet = jest.fn();

jest.mock('grammy', () => ({
  Bot: jest.fn(() => ({ on: mockOn, start: mockStart })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: any) => ({ input })),
}));

jest.mock('https', () => ({ get: mockHttpsGet }));

import { Bot } from 'grammy';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ChannelMemeEntity } from '../entities/channel-meme.entity';
import { ChannelMonitorBotService } from './channel-monitor-bot.service';

const MAIN = '-100111';
const BEST = '-100222';
const BOT_TOKEN = 'BOT-TOKEN';
const NOW = 1700000000000;

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    monitorBotToken: BOT_TOKEN,
    monitorMainChannel: MAIN,
    monitorBestChannel: BEST,
    tgEnv: 'prod',
    s3Endpoint: 'https://s3.test',
    s3Region: 'ru-central1',
    s3AccessKeyId: 'key-id',
    s3SecretAccessKey: 'secret',
    s3Bucket: 'memes-bucket',
    ...overrides,
  };
}

function makeRepo(): any {
  return {
    findOne: jest.fn(),
    count: jest.fn(),
    find: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function makeS3Service(): any {
  return {
    uploadLastMemeFromBuffer: jest.fn().mockResolvedValue(undefined),
    uploadBestMemesFromBuffers: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMeme(overrides: Partial<ChannelMemeEntity> = {}): ChannelMemeEntity {
  return Object.assign(new ChannelMemeEntity(), { id: 1, ...overrides });
}

function makeCtx(options: {
  chatId?: number;
  photo?: any[];
  messageId?: number;
  caption?: string;
  getFile?: jest.Mock;
  message?: any;
} = {}): any {
  const {
    chatId = Number(MAIN),
    photo = [{ file_id: 'file-1', file_size: 2048 }],
    messageId = 42,
    caption,
    getFile = jest.fn().mockResolvedValue({ file_path: 'photos/meme.jpg' }),
  } = options;

  const channelPost =
    options.message === null
      ? undefined
      : options.message ?? { chat: { id: chatId }, photo, message_id: messageId, caption };

  return { channelPost, api: { getFile } };
}

describe('ChannelMonitorBotService', () => {
  let repo: any;
  let config: any;
  let s3: any;
  let service: ChannelMonitorBotService;
  let handlers: Record<string, (ctx: any) => any>;

  async function init(overrides: Record<string, unknown> = {}) {
    repo = makeRepo();
    config = makeConfig(overrides);
    s3 = makeS3Service();
    service = new ChannelMonitorBotService(repo, config, s3);
    await service.onModuleInit();
    return service;
  }

  beforeEach(() => {
    mockOn.mockReset();
    mockStart.mockReset();
    mockS3Send.mockReset();
    mockHttpsGet.mockReset();
    (Bot as unknown as jest.Mock).mockClear();
    (PutObjectCommand as unknown as jest.Mock).mockClear();

    handlers = {};
    mockOn.mockImplementation((event: string, cb: (ctx: any) => any) => {
      handlers[event] = cb;
    });
    mockStart.mockResolvedValue(undefined);
    mockS3Send.mockResolvedValue({});
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function stubDownload(chunks: Buffer[] = [Buffer.from('image')], statusCode = 200) {
    const response: any = { statusCode };
    response.on = jest.fn((event: string, cb: (arg?: any) => void) => {
      if (event === 'data') {
        chunks.forEach((chunk) => cb(chunk));
      }
      if (event === 'end') {
        cb();
      }
      return response;
    });
    const request: any = { on: jest.fn(() => request) };
    mockHttpsGet.mockImplementationOnce((_url: string, cb: (res: any) => void) => {
      cb(response);
      return request;
    });
    return { response, request };
  }

  describe('onModuleInit / initializeBot / startBot', () => {
    it('инициализирует бота, подписывается на channel_post:photo и запускает его', async () => {
      await init();

      expect(Bot).toHaveBeenCalledWith(BOT_TOKEN, { client: { environment: 'prod' } });
      expect(mockOn).toHaveBeenCalledWith('channel_post:photo', expect.any(Function));
      expect(typeof handlers['channel_post:photo']).toBe('function');
      expect(mockStart).toHaveBeenCalledWith({ onStart: expect.any(Function) });
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'Channel Monitor Bot initialized successfully'
      );
      expect(Logger.prototype.log).toHaveBeenCalledWith(`Monitoring main channel: ${MAIN}`);
      expect(Logger.prototype.log).toHaveBeenCalledWith(`Monitoring best channel: ${BEST}`);

      const onStart = mockStart.mock.calls[0][0].onStart;
      onStart();
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        'Channel Monitor Bot started successfully'
      );
    });

    it('пробрасывает ошибку инициализации и логирует её', async () => {
      (Bot as unknown as jest.Mock).mockImplementationOnce(() => {
        throw new Error('bad token');
      });
      repo = makeRepo();
      config = makeConfig();
      s3 = makeS3Service();
      service = new ChannelMonitorBotService(repo, config, s3);

      await expect(service.onModuleInit()).rejects.toThrow('bad token');
      expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to initialize bot:', expect.any(Error));
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('пробрасывает ошибку запуска бота и логирует её', async () => {
      mockStart.mockImplementationOnce(() => {
        throw new Error('start failed');
      });
      repo = makeRepo();
      config = makeConfig();
      s3 = makeS3Service();
      service = new ChannelMonitorBotService(repo, config, s3);

      await expect(service.onModuleInit()).rejects.toThrow('start failed');
      expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to start bot:', expect.any(Error));
    });
  });

  describe('handleChannelPost', () => {
    it('обрабатывает фото из MAIN-канала: S3, БД и last-meme', async () => {
      await init();
      stubDownload([Buffer.from('binary-image')]);
      const ctx = makeCtx({ caption: 'подпись' });

      await handlers['channel_post:photo'](ctx);

      expect(Logger.prototype.log).toHaveBeenCalledWith('Identified as MAIN channel');
      expect(ctx.api.getFile).toHaveBeenCalledWith('file-1');
      expect(mockHttpsGet).toHaveBeenCalledWith(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/meme.jpg`,
        expect.any(Function)
      );
      const expectedKey = `channel-memes/main/${NOW}-42.jpg`;
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'memes-bucket',
        Key: expectedKey,
        Body: Buffer.from('binary-image'),
        ContentType: 'image/jpeg',
      });
      expect(repo.create).toHaveBeenCalledWith({
        channelId: MAIN,
        channelType: 'main',
        messageId: 42,
        s3Key: expectedKey,
        caption: 'подпись',
        fileId: 'file-1',
        fileSize: 2048,
      });
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ channelType: 'main' }));
      expect(s3.uploadLastMemeFromBuffer).toHaveBeenCalledWith(Buffer.from('binary-image'));
      expect(s3.uploadBestMemesFromBuffers).not.toHaveBeenCalled();
      expect(Logger.prototype.log).toHaveBeenCalledWith('Updated last-meme in S3');
    });

    it('обрабатывает фото из BEST-канала: best-meme и fileSize из буфера', async () => {
      await init();
      stubDownload([Buffer.from('best-image')]);
      const ctx = makeCtx({ chatId: Number(BEST), photo: [{ file_id: 'file-1' }] });

      await handlers['channel_post:photo'](ctx);

      expect(Logger.prototype.log).toHaveBeenCalledWith('Identified as BEST channel');
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: 'best',
          caption: undefined,
          fileSize: Buffer.from('best-image').length,
        })
      );
      expect(s3.uploadBestMemesFromBuffers).toHaveBeenCalledWith([Buffer.from('best-image')]);
      expect(s3.uploadLastMemeFromBuffer).not.toHaveBeenCalled();
    });

    it('в test-окружении добавляет /test/ в URL Telegram-файла', async () => {
      await init({ tgEnv: 'test' });
      stubDownload();

      await handlers['channel_post:photo'](makeCtx());

      expect(mockHttpsGet).toHaveBeenCalledWith(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/test/photos/meme.jpg`,
        expect.any(Function)
      );
    });

    it('игнорирует сообщение без channelPost', async () => {
      await init();
      await handlers['channel_post:photo'](makeCtx({ message: null }));

      expect(mockHttpsGet).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('игнорирует сообщение без фото', async () => {
      await init();
      await handlers['channel_post:photo'](makeCtx({ photo: null }));

      expect(mockHttpsGet).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('игнорирует фото из неизвестного канала', async () => {
      await init();
      await handlers['channel_post:photo'](makeCtx({ chatId: -100999 }));

      expect(Logger.prototype.warn).toHaveBeenCalledWith('Received message from UNKNOWN channel: -100999');
      expect(Logger.prototype.warn).toHaveBeenCalledWith(`Expected main: ${MAIN} or best: ${BEST}`);
      expect(mockHttpsGet).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('логирует и не падает при ошибке внутри обработки', async () => {
      await init();
      const getFile = jest.fn().mockRejectedValue(new Error('tg error'));
      await handlers['channel_post:photo'](makeCtx({ getFile }));

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Error handling channel post:',
        expect.any(Error)
      );
    });

    it('логгирует ошибку при неуспешном статусе скачивания', async () => {
      await init();
      stubDownload([Buffer.from('')], 500);

      await handlers['channel_post:photo'](makeCtx());

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Error handling channel post:',
        expect.objectContaining({ message: 'Failed to download file: 500' })
      );
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('логирует и не падает при ошибке загрузки в S3', async () => {
      await init();
      stubDownload();
      mockS3Send.mockRejectedValueOnce(new Error('s3 down'));

      await handlers['channel_post:photo'](makeCtx());

      expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to upload to S3:', expect.any(Error));
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Error handling channel post:',
        expect.any(Error)
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('downloadFile', () => {
    it('склеивает чанки в буфер', async () => {
      await init();
      stubDownload([Buffer.from('ab'), Buffer.from('cd')]);

      const buffer = await (service as any).downloadFile('https://tg/file');

      expect(buffer).toEqual(Buffer.from('abcd'));
    });

    it('отклоняет промис при статусе ответа не 200', async () => {
      await init();
      stubDownload([], 404);

      await expect((service as any).downloadFile('https://tg/file')).rejects.toThrow(
        'Failed to download file: 404'
      );
    });

    it('отклоняет промис при событии error у ответа', async () => {
      await init();
      const response: any = {
        statusCode: 200,
        on: jest.fn((event: string, cb: (arg?: any) => void) => {
          if (event === 'error') {
            cb(new Error('stream broken'));
          }
          return response;
        }),
      };
      mockHttpsGet.mockImplementationOnce((_url: string, cb: (res: any) => void) => {
        cb(response);
        return { on: jest.fn() };
      });

      await expect((service as any).downloadFile('https://tg/file')).rejects.toThrow(
        'stream broken'
      );
    });

    it('отклоняет промис при ошибке самого запроса', async () => {
      await init();
      const request: any = {
        on: jest.fn((event: string, cb: (arg?: any) => void) => {
          if (event === 'error') {
            cb(new Error('socket hang up'));
          }
          return request;
        }),
      };
      mockHttpsGet.mockReturnValueOnce(request);

      await expect((service as any).downloadFile('https://tg/file')).rejects.toThrow(
        'socket hang up'
      );
    });
  });

  describe('uploadToS3', () => {
    it('отправляет команду в S3 и логирует ключ', async () => {
      await init();

      await (service as any).uploadToS3(Buffer.from('x'), 'some/key.jpg');

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ Key: 'some/key.jpg' }) })
      );
      expect(Logger.prototype.log).toHaveBeenCalledWith('Uploaded to S3: some/key.jpg');
    });

    it('логирует и пробрасывает ошибку S3', async () => {
      await init();
      mockS3Send.mockRejectedValueOnce(new Error('denied'));

      await expect((service as any).uploadToS3(Buffer.from('x'), 'k')).rejects.toThrow('denied');
      expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to upload to S3:', expect.any(Error));
    });
  });

  describe('запросы мемов', () => {
    it('getLastMeme ищет последний main-мем', async () => {
      await init();
      const meme = makeMeme({ channelType: 'main' });
      repo.findOne.mockResolvedValueOnce(meme);

      await expect(service.getLastMeme()).resolves.toBe(meme);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { channelType: 'main' },
        order: { createdAt: 'DESC' },
      });
    });

    it('getLastBestMeme ищет последний best-мем', async () => {
      await init();
      const meme = makeMeme({ channelType: 'best' });
      repo.findOne.mockResolvedValueOnce(meme);

      await expect(service.getLastBestMeme()).resolves.toBe(meme);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { channelType: 'best' },
        order: { createdAt: 'DESC' },
      });
    });

    it('getRandomMeme возвращает null при пустой базе', async () => {
      await init();
      repo.count.mockResolvedValueOnce(0);

      await expect(service.getRandomMeme()).resolves.toBeNull();
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('getRandomMeme берёт случайную строку со смещением', async () => {
      await init();
      const meme = makeMeme();
      repo.count.mockResolvedValueOnce(3);
      repo.find.mockResolvedValueOnce([meme]);
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      await expect(service.getRandomMeme()).resolves.toBe(meme);
      expect(repo.find).toHaveBeenCalledWith({ skip: 1, take: 1 });
    });

    it('getRandomMeme возвращает null, если выборка пуста', async () => {
      await init();
      repo.count.mockResolvedValueOnce(2);
      repo.find.mockResolvedValueOnce([]);

      await expect(service.getRandomMeme()).resolves.toBeNull();
    });

    it('getRandomMemeByType возвращает null при пустой базе', async () => {
      await init();
      repo.count.mockResolvedValueOnce(0);

      await expect(service.getRandomMemeByType('best')).resolves.toBeNull();
      expect(repo.count).toHaveBeenCalledWith({ where: { channelType: 'best' } });
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('getRandomMemeByType фильтрует по типу канала', async () => {
      await init();
      const meme = makeMeme({ channelType: 'main' });
      repo.count.mockResolvedValueOnce(4);
      repo.find.mockResolvedValueOnce([meme]);
      jest.spyOn(Math, 'random').mockReturnValue(0);

      await expect(service.getRandomMemeByType('main')).resolves.toBe(meme);
      expect(repo.find).toHaveBeenCalledWith({
        where: { channelType: 'main' },
        skip: 0,
        take: 1,
      });
    });

    it('getRandomMemeByType возвращает null, если выборка пуста', async () => {
      await init();
      repo.count.mockResolvedValueOnce(1);
      repo.find.mockResolvedValueOnce([]);

      await expect(service.getRandomMemeByType('best')).resolves.toBeNull();
    });

    it('getBestMemes использует лимит по умолчанию 10', async () => {
      await init();
      repo.find.mockResolvedValueOnce([]);

      await service.getBestMemes();

      expect(repo.find).toHaveBeenCalledWith({
        where: { channelType: 'best' },
        order: { createdAt: 'DESC' },
        take: 10,
      });
    });

    it('getBestMemes принимает явный лимит', async () => {
      await init();
      repo.find.mockResolvedValueOnce([]);

      await service.getBestMemes(3);

      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3 })
      );
    });

    it('getAllMemes использует лимит по умолчанию 50', async () => {
      await init();
      repo.find.mockResolvedValueOnce([]);

      await service.getAllMemes();

      expect(repo.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        take: 50,
      });
    });

    it('getAllMemes принимает явный лимит', async () => {
      await init();
      repo.find.mockResolvedValueOnce([]);

      await service.getAllMemes(7);

      expect(repo.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        take: 7,
      });
    });
  });
});
