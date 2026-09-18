jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));

import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { MemeUploadService } from './meme-upload.service';

const MEME_CHANNEL = -1001111111111;
const BEST_CHANNEL = -1002222222222;

function createConfig(overrides: any = {}): any {
  return {
    memeChanelId: MEME_CHANNEL,
    bestMemeChanelId: BEST_CHANNEL,
    botToken: 'BOT_TOKEN',
    tgEnv: 'prod',
    ...overrides,
  };
}

function createService(overrides: any = {}) {
  const s3Service = {
    uploadLastMemeFromBuffer: jest.fn().mockResolvedValue(undefined),
    uploadBestMemesFromBuffers: jest.fn().mockResolvedValue(undefined),
  };
  const configService = createConfig(overrides);
  const httpService = {
    get: jest.fn().mockReturnValue(of({ data: new Uint8Array([1, 2, 3]) })),
  };
  const service = new MemeUploadService(s3Service as any, configService, httpService as any);
  return { service, s3Service, configService, httpService };
}

function makeContext(overrides: any = {}): any {
  return {
    channelPost: {
      chat: { id: MEME_CHANNEL },
      photo: [{ file_id: 'file-id' }],
    },
    api: {
      getFile: jest.fn().mockResolvedValue({ file_path: 'photos/meme.jpg' }),
    },
    ...overrides,
  };
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('MemeUploadService.handleChannelPost', () => {
  it('предупреждает и выходит, когда в контексте нет сообщения', async () => {
    const { service } = createService();

    await service.handleChannelPost({} as any);

    expect(Logger.prototype.warn).toHaveBeenCalledWith('No message found in context');
  });

  it('берёт ctx.message, если channelPost отсутствует', async () => {
    const { service, s3Service } = createService();
    const ctx = makeContext({
      channelPost: undefined,
      message: { chat: { id: MEME_CHANNEL }, photo: [{ file_id: 'f' }] },
    });

    await service.handleChannelPost(ctx);

    expect(s3Service.uploadLastMemeFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('предупреждает и выходит, когда в сообщении нет фото', async () => {
    const { service, s3Service } = createService();
    const ctx = makeContext({ channelPost: { chat: { id: MEME_CHANNEL }, photo: [] } });

    await service.handleChannelPost(ctx);

    expect(Logger.prototype.warn).toHaveBeenCalledWith('No photo found in message');
    expect(s3Service.uploadLastMemeFromBuffer).not.toHaveBeenCalled();
  });

  it('предупреждает и выходит, когда Telegram не вернул file_path', async () => {
    const { service, s3Service } = createService();
    const ctx = makeContext();
    ctx.api.getFile.mockResolvedValue({ file_id: 'x' });

    await service.handleChannelPost(ctx);

    expect(Logger.prototype.warn).toHaveBeenCalledWith('Cannot get file path for file_id: file-id');
    expect(s3Service.uploadLastMemeFromBuffer).not.toHaveBeenCalled();
  });

  it('скачивает и загружает последний мем из основного канала', async () => {
    const { service, s3Service, httpService } = createService();
    const ctx = makeContext();

    await service.handleChannelPost(ctx);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botBOT_TOKEN/photos/meme.jpg',
      { responseType: 'arraybuffer' }
    );
    expect(s3Service.uploadLastMemeFromBuffer).toHaveBeenCalledTimes(1);
    expect(s3Service.uploadLastMemeFromBuffer.mock.calls[0][0]).toEqual(Buffer.from([1, 2, 3]));
    expect(s3Service.uploadBestMemesFromBuffers).not.toHaveBeenCalled();
  });

  it('для тестового окружения добавляет /test/ в URL файла', async () => {
    const { service, httpService } = createService({ tgEnv: 'test' });
    const ctx = makeContext();

    await service.handleChannelPost(ctx);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botBOT_TOKEN/test/photos/meme.jpg',
      { responseType: 'arraybuffer' }
    );
  });

  it('буферизует мем из канала лучших мемов', async () => {
    const { service, s3Service } = createService();
    const bufferSpy = jest.spyOn(service as any, 'bufferBestMeme').mockImplementation(() => undefined);
    const ctx = makeContext({ channelPost: { chat: { id: BEST_CHANNEL }, photo: [{ file_id: 'b' }] } });

    await service.handleChannelPost(ctx);

    expect(bufferSpy).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(s3Service.uploadLastMemeFromBuffer).not.toHaveBeenCalled();
  });

  it('предупреждает о неизвестном канале', async () => {
    const { service, s3Service } = createService();
    const ctx = makeContext({ channelPost: { chat: { id: -999 }, photo: [{ file_id: 'x' }] } });

    await service.handleChannelPost(ctx);

    expect(Logger.prototype.warn).toHaveBeenCalledWith('Unknown channel ID: -999');
    expect(s3Service.uploadLastMemeFromBuffer).not.toHaveBeenCalled();
    expect(s3Service.uploadBestMemesFromBuffers).not.toHaveBeenCalled();
  });

  it('ловит ошибку Error и логирует её вместе со стеком', async () => {
    const { service } = createService();
    const ctx = makeContext();
    ctx.api.getFile.mockRejectedValue(new Error('api failure'));

    await service.handleChannelPost(ctx);

    expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to handle channel post: api failure');
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('Stack trace:'));
  });

  it('ловит не-Error исключение как Unknown error', async () => {
    const { service } = createService();
    const ctx = makeContext();
    ctx.api.getFile.mockRejectedValue('nope');

    await service.handleChannelPost(ctx);

    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to handle channel post: Unknown error'
    );
    expect(Logger.prototype.error).toHaveBeenCalledWith('Stack trace: ');
  });
});

describe('MemeUploadService.bufferBestMeme', () => {
  it('добавляет буфер и перезапускает единственный таймер на 60 секунд', () => {
    jest.useFakeTimers();
    const { service } = createService();
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    (service as any).bufferBestMeme(Buffer.from('first'));
    expect(jest.getTimerCount()).toBe(1);
    expect(clearSpy).not.toHaveBeenCalled();

    (service as any).bufferBestMeme(Buffer.from('second'));
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    expect((service as any).bestMemesBuffer).toHaveLength(2);
  });

  it('через минуту вызывает загрузку буферизованных мемов', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    const uploadSpy = jest
      .spyOn(service as any, 'uploadBufferedBestMemes')
      .mockResolvedValue(undefined);

    (service as any).bufferBestMeme(Buffer.from('meme'));
    jest.advanceTimersByTime(60000);
    await flush();

    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });
});

describe('MemeUploadService.uploadBufferedBestMemes', () => {
  it('ничего не делает при пустом буфере', async () => {
    const { service, s3Service } = createService();

    await (service as any).uploadBufferedBestMemes();

    expect(s3Service.uploadBestMemesFromBuffers).not.toHaveBeenCalled();
  });

  it('загружает не более двух мемов и очищает буфер', async () => {
    const { service, s3Service } = createService();
    (service as any).bestMemesBuffer = [
      Buffer.from('a'),
      Buffer.from('b'),
      Buffer.from('c'),
    ];

    await (service as any).uploadBufferedBestMemes();

    expect(s3Service.uploadBestMemesFromBuffers).toHaveBeenCalledWith([
      Buffer.from('a'),
      Buffer.from('b'),
    ]);
    expect((service as any).bestMemesBuffer).toEqual([]);
    expect((service as any).bestMemesTimer).toBeNull();
  });

  it('логирует ошибку загрузки, но всё равно очищает буфер', async () => {
    const { service, s3Service } = createService();
    s3Service.uploadBestMemesFromBuffers.mockRejectedValue(new Error('s3 failed'));
    (service as any).bestMemesBuffer = [Buffer.from('a')];
    (service as any).bestMemesTimer = { fake: true } as any;

    await (service as any).uploadBufferedBestMemes();

    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload buffered best memes: s3 failed'
    );
    expect((service as any).bestMemesBuffer).toEqual([]);
    expect((service as any).bestMemesTimer).toBeNull();
  });

  it('логирует Unknown error при не-Error исключении', async () => {
    const { service, s3Service } = createService();
    s3Service.uploadBestMemesFromBuffers.mockRejectedValue('bad');
    (service as any).bestMemesBuffer = [Buffer.from('a')];

    await (service as any).uploadBufferedBestMemes();

    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload buffered best memes: Unknown error'
    );
  });
});

describe('MemeUploadService.forceUpdateMemes', () => {
  it('логирует запуск принудительного обновления', async () => {
    const { service } = createService();

    await service.forceUpdateMemes();

    expect(Logger.prototype.log).toHaveBeenCalledWith('Force updating memes from channels...');
  });
});
