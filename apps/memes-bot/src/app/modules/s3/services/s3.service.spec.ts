jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutObjectCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

jest.mock('http', () => ({ get: jest.fn() }));
jest.mock('https', () => ({ get: jest.fn() }));

import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MemeType, S3Service } from './s3.service';

const CONFIG = {
  s3Bucket: 'meme-bucket',
  s3Endpoint: 'http://s3.local:9000',
  s3Region: 'ru-central-1',
  s3AccessKeyId: 'access-key',
  s3SecretAccessKey: 'secret-key',
};

function createService(config: any = CONFIG): S3Service {
  return new S3Service(config);
}

function getSendMock(service: S3Service): jest.Mock {
  return (service as any).s3Client.send as jest.Mock;
}

/** Ответ, который умеет отдавать чанки, ошибку и статус-код. */
function makeResponse(statusCode: number, chunks: Buffer[] = [], error?: Error): EventEmitter {
  const response = new EventEmitter() as any;
  response.statusCode = statusCode;
  if (chunks.length) {
    response.chunks = chunks;
  }
  if (error) {
    response.failWith = error;
  }
  return response;
}

function mockHttpSuccess(
  getMock: jest.Mock,
  statusCode: number,
  chunks: Buffer[]
): void {
  getMock.mockImplementation((_url: string, callback: (res: any) => void) => {
    const request = new EventEmitter() as any;
    const response = makeResponse(statusCode);
    callback(response);
    chunks.forEach((chunk) => response.emit('data', chunk));
    response.emit('end');
    return request;
  });
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  (http.get as jest.Mock).mockReset();
  (https.get as jest.Mock).mockReset();
  (S3Client as unknown as jest.Mock).mockClear();
  (PutObjectCommand as unknown as jest.Mock).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('S3Service конструктор', () => {
  it('инициализирует клиент с учётными данными из конфига', () => {
    createService();

    expect(S3Client).toHaveBeenCalledTimes(1);
    expect((S3Client as unknown as jest.Mock).mock.calls[0][0]).toEqual({
      endpoint: CONFIG.s3Endpoint,
      region: CONFIG.s3Region,
      credentials: {
        accessKeyId: CONFIG.s3AccessKeyId,
        secretAccessKey: CONFIG.s3SecretAccessKey,
      },
    });
    expect(Logger.prototype.log).toHaveBeenCalledWith('S3 client initialized successfully');
  });

  it('логирует и пробрасывает ошибку конфига (Error)', () => {
    const broken = {} as any;
    Object.defineProperty(broken, 's3Bucket', {
      get() {
        throw new Error('S3_BUCKET is missing');
      },
    });

    expect(() => createService(broken)).toThrow('S3_BUCKET is missing');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to initialize S3 client: S3_BUCKET is missing'
    );
  });

  it('обрабатывает неизвестную ошибку инициализации как Unknown error', () => {
    const broken = {} as any;
    Object.defineProperty(broken, 's3Bucket', {
      get() {
        throw 'boom';
      },
    });

    expect(() => createService(broken)).toThrow();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to initialize S3 client: Unknown error'
    );
  });
});

describe('S3Service.uploadImage', () => {
  it('загружает последний мем по URL и ставит image/jpeg для .jpg', async () => {
    const service = createService();
    const send = getSendMock(service);
    jest.spyOn(service as any, 'downloadImage').mockResolvedValue(Buffer.from('image-bytes'));

    await service.uploadImage('https://cdn.local/photo.jpg', MemeType.LAST_MEME);

    expect((service as any).downloadImage).toHaveBeenCalledWith('https://cdn.local/photo.jpg');
    expect(PutObjectCommand).toHaveBeenCalledTimes(1);
    const command = (PutObjectCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(command).toMatchObject({
      Bucket: 'meme-bucket',
      Key: 'last-meme/meme.img',
      Body: Buffer.from('image-bytes'),
      ContentType: 'image/jpeg',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual(command);
  });

  it('загружает лучший мем с позицией first', async () => {
    const service = createService();
    jest.spyOn(service as any, 'downloadImage').mockResolvedValue(Buffer.from('img'));

    await service.uploadImage('https://cdn.local/a.png', MemeType.BEST_MEME, 'first');

    expect((PutObjectCommand as unknown as jest.Mock).mock.calls[0][0]).toMatchObject({
      Key: 'best-meme/first.img',
      ContentType: 'image/png',
    });
  });

  it('загружает лучший мем с позицией second', async () => {
    const service = createService();
    jest.spyOn(service as any, 'downloadImage').mockResolvedValue(Buffer.from('img'));

    await service.uploadImage('https://cdn.local/a.webp', MemeType.BEST_MEME, 'second');

    expect((PutObjectCommand as unknown as jest.Mock).mock.calls[0][0]).toMatchObject({
      Key: 'best-meme/second.img',
      ContentType: 'image/webp',
    });
  });

  it('бросает ошибку, если для best-meme не передана позиция', async () => {
    const service = createService();
    jest.spyOn(service as any, 'downloadImage').mockResolvedValue(Buffer.from('img'));

    await expect(service.uploadImage('https://cdn.local/a.png', MemeType.BEST_MEME)).rejects.toThrow(
      'Position is required for best memes'
    );
    expect(getSendMock(service)).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload image: Position is required for best memes',
      expect.any(String)
    );
  });

  it('пробрасывает ошибку скачивания и логирует её', async () => {
    const service = createService();
    jest
      .spyOn(service as any, 'downloadImage')
      .mockRejectedValue(new Error('Failed to download image: 404'));

    await expect(
      service.uploadImage('https://cdn.local/missing.jpg', MemeType.LAST_MEME)
    ).rejects.toThrow('Failed to download image: 404');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload image: Failed to download image: 404',
      expect.anything()
    );
    expect(getSendMock(service)).not.toHaveBeenCalled();
  });

  it('пишет Unknown error при не-Error исключении', async () => {
    const service = createService();
    jest.spyOn(service as any, 'downloadImage').mockRejectedValue('network');

    await expect(service.uploadImage('https://cdn.local/x.jpg', MemeType.LAST_MEME)).rejects.toBe(
      'network'
    );
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload image: Unknown error',
      undefined
    );
  });
});

describe('S3Service.uploadLastMeme', () => {
  it('делегирует в uploadImage с типом LAST_MEME', async () => {
    const service = createService();
    const uploadSpy = jest.spyOn(service, 'uploadImage').mockResolvedValue(undefined);

    await service.uploadLastMeme('https://cdn.local/last.jpg');

    expect(uploadSpy).toHaveBeenCalledWith('https://cdn.local/last.jpg', MemeType.LAST_MEME);
  });
});

describe('S3Service.uploadLastMemeFromBuffer', () => {
  it('загружает буфер как jpeg по фиксированному ключу', async () => {
    const service = createService();
    const send = getSendMock(service);
    const buffer = Buffer.from('buffer-data');

    await service.uploadLastMemeFromBuffer(buffer);

    expect(PutObjectCommand).toHaveBeenCalledTimes(1);
    expect((PutObjectCommand as unknown as jest.Mock).mock.calls[0][0]).toMatchObject({
      Bucket: 'meme-bucket',
      Key: 'last-meme/meme.img',
      Body: buffer,
      ContentType: 'image/jpeg',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('пробрасывает ошибку S3 и логирует её', async () => {
    const service = createService();
    getSendMock(service).mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(service.uploadLastMemeFromBuffer(Buffer.from('x'))).rejects.toThrow('AccessDenied');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload image: AccessDenied',
      expect.anything()
    );
  });

  it('логирует Unknown error для не-Error исключения', async () => {
    const service = createService();
    getSendMock(service).mockRejectedValueOnce('nope');

    await expect(service.uploadLastMemeFromBuffer(Buffer.from('x'))).rejects.toBe('nope');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload image: Unknown error',
      undefined
    );
  });
});

describe('S3Service.uploadBestMemes', () => {
  it('загружает один лучший мем как first', async () => {
    const service = createService();
    const uploadSpy = jest.spyOn(service, 'uploadImage').mockResolvedValue(undefined);

    await service.uploadBestMemes(['https://cdn/one.jpg']);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledWith('https://cdn/one.jpg', MemeType.BEST_MEME, 'first');
  });

  it('загружает два лучших мема как first и second', async () => {
    const service = createService();
    const uploadSpy = jest.spyOn(service, 'uploadImage').mockResolvedValue(undefined);

    await service.uploadBestMemes(['https://cdn/one.jpg', 'https://cdn/two.jpg']);

    expect(uploadSpy).toHaveBeenNthCalledWith(
      1,
      'https://cdn/one.jpg',
      MemeType.BEST_MEME,
      'first'
    );
    expect(uploadSpy).toHaveBeenNthCalledWith(
      2,
      'https://cdn/two.jpg',
      MemeType.BEST_MEME,
      'second'
    );
  });

  it('отклоняет пустой массив', async () => {
    const service = createService();
    await expect(service.uploadBestMemes([])).rejects.toThrow(
      'Best memes array must contain 1 or 2 images'
    );
  });

  it('отклоняет массив из трёх элементов', async () => {
    const service = createService();
    await expect(service.uploadBestMemes(['a', 'b', 'c'])).rejects.toThrow(
      'Best memes array must contain 1 or 2 images'
    );
  });
});

describe('S3Service.uploadBestMemesFromBuffers', () => {
  it('загружает единственный буфер', async () => {
    const service = createService();
    const send = getSendMock(service);

    await service.uploadBestMemesFromBuffers([Buffer.from('one')]);

    expect(send).toHaveBeenCalledTimes(1);
    expect((PutObjectCommand as unknown as jest.Mock).mock.calls[0][0]).toMatchObject({
      Key: 'best-meme/first.img',
      ContentType: 'image/jpeg',
    });
  });

  it('загружает два буфера по порядку', async () => {
    const service = createService();
    const send = getSendMock(service);
    const first = Buffer.from('first');
    const second = Buffer.from('second');

    await service.uploadBestMemesFromBuffers([first, second]);

    expect(send).toHaveBeenCalledTimes(2);
    const commands = (PutObjectCommand as unknown as jest.Mock).mock.calls.map((c) => c[0]);
    expect(commands[0]).toMatchObject({ Key: 'best-meme/first.img', Body: first });
    expect(commands[1]).toMatchObject({ Key: 'best-meme/second.img', Body: second });
  });

  it('отклоняет пустой массив буферов', async () => {
    const service = createService();
    await expect(service.uploadBestMemesFromBuffers([])).rejects.toThrow(
      'Best memes array must contain 1 or 2 images'
    );
  });

  it('отклоняет более двух буферов', async () => {
    const service = createService();
    await expect(
      service.uploadBestMemesFromBuffers([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')])
    ).rejects.toThrow('Best memes array must contain 1 or 2 images');
  });

  it('пробрасывает ошибку S3 и логирует её', async () => {
    const service = createService();
    getSendMock(service).mockRejectedValueOnce(new Error('S3 down'));

    await expect(service.uploadBestMemesFromBuffers([Buffer.from('a')])).rejects.toThrow('S3 down');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload images: S3 down',
      expect.anything()
    );
  });

  it('логирует Unknown error для не-Error исключения', async () => {
    const service = createService();
    getSendMock(service).mockRejectedValueOnce(42);

    await expect(service.uploadBestMemesFromBuffers([Buffer.from('a')])).rejects.toBe(42);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to upload images: Unknown error',
      undefined
    );
  });
});

describe('S3Service.downloadImage', () => {
  it('склеивает чанки из https-ответа со статусом 200', async () => {
    const service = createService();
    mockHttpSuccess(https.get as jest.Mock, 200, [Buffer.from('ab'), Buffer.from('cd')]);

    const result = await (service as any).downloadImage('https://cdn.local/img.jpg');

    expect(https.get).toHaveBeenCalledWith('https://cdn.local/img.jpg', expect.any(Function));
    expect(http.get).not.toHaveBeenCalled();
    expect(result).toEqual(Buffer.from('abcd'));
  });

  it('использует http для не-https ссылок', async () => {
    const service = createService();
    mockHttpSuccess(http.get as jest.Mock, 200, [Buffer.from('xx')]);

    const result = await (service as any).downloadImage('http://cdn.local/img.jpg');

    expect(http.get).toHaveBeenCalled();
    expect(https.get).not.toHaveBeenCalled();
    expect(result).toEqual(Buffer.from('xx'));
  });

  it('отклоняет промис при статусе не 200', async () => {
    const service = createService();
    (https.get as jest.Mock).mockImplementation((_url: string, callback: (res: any) => void) => {
      const request = new EventEmitter() as any;
      callback(makeResponse(404));
      return request;
    });

    await expect((service as any).downloadImage('https://cdn.local/gone.jpg')).rejects.toThrow(
      'Failed to download image: 404'
    );
  });

  it('отклоняет промис при ошибке потока ответа', async () => {
    const service = createService();
    (https.get as jest.Mock).mockImplementation((_url: string, callback: (res: any) => void) => {
      const request = new EventEmitter() as any;
      const response = makeResponse(200);
      callback(response);
      response.emit('error', new Error('response exploded'));
      return request;
    });

    await expect((service as any).downloadImage('https://cdn.local/img.jpg')).rejects.toThrow(
      'response exploded'
    );
  });

  it('отклоняет промис при ошибке самого запроса', async () => {
    const service = createService();
    (https.get as jest.Mock).mockImplementation(() => {
      const request = new EventEmitter() as any;
      process.nextTick(() => request.emit('error', new Error('socket hang up')));
      return request;
    });

    await expect((service as any).downloadImage('https://cdn.local/img.jpg')).rejects.toThrow(
      'socket hang up'
    );
  });
});

describe('S3Service.getContentType', () => {
  let service: S3Service;

  beforeEach(() => {
    service = createService();
  });

  it.each([
    ['https://cdn/a.jpg', 'image/jpeg'],
    ['https://cdn/a.JPEG', 'image/jpeg'],
    ['https://cdn/a.png', 'image/png'],
    ['https://cdn/a.gif', 'image/gif'],
    ['https://cdn/a.webp', 'image/webp'],
    ['https://cdn/a.bmp', 'application/octet-stream'],
    ['https://cdn/no-extension', 'application/octet-stream'],
  ])('определяет тип для %s', (url, expected) => {
    expect((service as any).getContentType(url)).toBe(expected);
  });
});
