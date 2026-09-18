jest.mock('imghash', () => ({ __esModule: true, hash: jest.fn() }));
jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('../providers/bot.provider', () => ({ BOT: 'APP_BOT_TOKEN' }));

import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import * as imghash from 'imghash';
import { DeduplicationService } from './deduplication.service';

const hashMock = imghash.hash as unknown as jest.Mock;

interface Overrides {
  tgEnv?: 'prod' | 'test';
  botToken?: string;
  httpGet?: jest.Mock;
  query?: jest.Mock;
  insert?: jest.Mock;
  getFile?: jest.Mock;
}

function setup(overrides: Overrides = {}) {
  const httpService = { get: overrides.httpGet ?? jest.fn() } as any;
  const baseConfigService = {
    tgEnv: overrides.tgEnv ?? 'prod',
    botToken: overrides.botToken ?? 'TOKEN',
  } as any;
  const publishedPostHashesEntity = {
    query: overrides.query ?? jest.fn(),
    insert: overrides.insert ?? jest.fn().mockResolvedValue(undefined),
  } as any;
  const bot = { api: { getFile: overrides.getFile ?? jest.fn() } } as any;
  const service = new DeduplicationService(
    httpService,
    baseConfigService,
    publishedPostHashesEntity,
    bot
  );
  return { service, httpService, baseConfigService, publishedPostHashesEntity, bot };
}

describe('DeduplicationService', () => {
  beforeEach(() => {
    hashMock.mockReset();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkDuplicate', () => {
    it('возвращает пустой массив для пустого хеша и не ходит в БД', async () => {
      const { service, publishedPostHashesEntity } = setup();
      await expect(service.checkDuplicate('')).resolves.toEqual([]);
      expect(publishedPostHashesEntity.query).not.toHaveBeenCalled();
    });

    it('маппит строки БД в memePostId/distance и передаёт хеш параметром', async () => {
      const query = jest.fn().mockResolvedValue([
        { hash: 'abc', memeChannelMessageId: 11, distance: 0.91 },
        { hash: 'def', memeChannelMessageId: 22, distance: 0.5 },
      ]);
      const { service } = setup({ query });

      await expect(service.checkDuplicate('abc')).resolves.toEqual([
        { memePostId: 11, distance: 0.91 },
        { memePostId: 22, distance: 0.5 },
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('SIMILARITY(hash, $1)');
      expect(params).toEqual(['abc']);
    });

    it('при отсутствии pg_trgm (similarity) пишет warn и возвращает []', async () => {
      const error = new Error('function similarity(text, unknown) does not exist');
      const query = jest.fn().mockRejectedValue(error);
      const { service } = setup({ query });

      await expect(service.checkDuplicate('abc')).resolves.toEqual([]);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('SIMILARITY function not available')
      );
    });

    it('распознаёт SIMILARITY в верхнем регистре', async () => {
      const query = jest.fn().mockRejectedValue(new Error('SIMILARITY not found'));
      const { service } = setup({ query });

      await expect(service.checkDuplicate('abc')).resolves.toEqual([]);
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('пробрасывает прочие ошибки БД без глушения', async () => {
      const error = new Error('connection refused');
      const query = jest.fn().mockRejectedValue(error);
      const { service } = setup({ query });

      await expect(service.checkDuplicate('abc')).rejects.toBe(error);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('пробрасывает ошибку без message (optional chaining)', async () => {
      const query = jest.fn().mockRejectedValue({ code: 'ECONN' });
      const { service } = setup({ query });

      await expect(service.checkDuplicate('abc')).rejects.toEqual({ code: 'ECONN' });
    });
  });

  describe('createPublishedPostHash', () => {
    it('вставляет запись, когда хеш есть', async () => {
      const insert = jest.fn().mockResolvedValue(undefined);
      const { service } = setup({ insert });

      await service.createPublishedPostHash('hash-1', 77);

      expect(insert).toHaveBeenCalledWith({ hash: 'hash-1', memeChannelMessageId: 77 });
    });

    it('не вставляет пустой хеш, а пишет warn', async () => {
      const insert = jest.fn();
      const { service } = setup({ insert });

      await service.createPublishedPostHash('', 77);

      expect(insert).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot create hash for memeChannelMessageId 77')
      );
    });
  });

  describe('calculateHashDistance', () => {
    it('возвращает 0 для пустых хешей', () => {
      const { service } = setup();
      expect(service.calculateHashDistance('', 'abc')).toBe(0);
      expect(service.calculateHashDistance('abc', '')).toBe(0);
    });

    it('возвращает 0 при разной длине хешей', () => {
      const { service } = setup();
      expect(service.calculateHashDistance('1010', '101')).toBe(0);
    });

    it('возвращает 1 для идентичных хешей', () => {
      const { service } = setup();
      expect(service.calculateHashDistance('1010', '1010')).toBe(1);
    });

    it('считает долю совпадающих символов', () => {
      const { service } = setup();
      expect(service.calculateHashDistance('1010', '1001')).toBe(0.5);
      expect(service.calculateHashDistance('1111', '1110')).toBe(0.75);
    });
  });

  describe('getPostImageHash', () => {
    it('возвращает null и warn, если фото нет', async () => {
      const { service } = setup();
      await expect(service.getPostImageHash(undefined as any)).resolves.toBeNull();
      await expect(service.getPostImageHash([])).resolves.toBeNull();
      expect(Logger.prototype.warn).toHaveBeenCalledWith('No photo provided for hashing');
    });

    it('в prod хеширует выбранный по высоте файл (URL без /test/)', async () => {
      const fileBuffer = Buffer.from('image');
      const httpGet = jest.fn().mockReturnValue(of({ data: fileBuffer }));
      const getFile = jest.fn().mockResolvedValue({ file_path: 'photos/a.jpg' });
      hashMock.mockResolvedValue('HASHED');
      const { service } = setup({ httpGet, getFile, tgEnv: 'prod' });

      const photo = [
        { file_id: 'small', height: 100 } as any,
        { file_id: 'mid', height: 500 } as any,
        { file_id: 'big', height: 1200 } as any,
      ];
      const result = await service.getPostImageHash(photo);

      expect(result).toBe('HASHED');
      expect(getFile).toHaveBeenCalledWith('mid');
      expect(httpGet).toHaveBeenCalledWith(
        'https://api.telegram.org/file/botTOKEN/photos/a.jpg',
        { responseType: 'arraybuffer' }
      );
      expect(hashMock).toHaveBeenCalledWith(fileBuffer, 16);
    });

    it('если подходящего размера нет, берёт последний файл', async () => {
      const httpGet = jest.fn().mockReturnValue(of({ data: Buffer.from('x') }));
      const getFile = jest.fn().mockResolvedValue({ file_path: 'photos/last.jpg' });
      hashMock.mockResolvedValue('LAST');
      const { service } = setup({ httpGet, getFile, tgEnv: 'test' });

      const photo = [
        { file_id: 'tiny', height: 50 } as any,
        { file_id: 'huge', height: 2000 } as any,
      ];
      await expect(service.getPostImageHash(photo)).resolves.toBe('LAST');
      expect(getFile).toHaveBeenCalledWith('huge');
      expect(httpGet).toHaveBeenCalledWith(
        'https://api.telegram.org/file/botTOKEN/test/photos/last.jpg',
        { responseType: 'arraybuffer' }
      );
    });

    it('возвращает null, если Telegram не отдал файл', async () => {
      const getFile = jest.fn().mockResolvedValue(undefined);
      const { service } = setup({ getFile });

      await expect(service.getPostImageHash([{ file_id: 'a', height: 500 } as any])).resolves.toBeNull();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot get file path for file_id: a')
      );
    });

    it('возвращает null, если у файла нет file_path', async () => {
      const getFile = jest.fn().mockResolvedValue({ file_id: 'a' });
      const { service } = setup({ getFile });

      await expect(service.getPostImageHash([{ file_id: 'a', height: 500 } as any])).resolves.toBeNull();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot get file path')
      );
    });

    it('в test-среде после сбоя пробует альтернативный URL с User-Agent', async () => {
      const fileBuffer = Buffer.from('alt');
      const httpGet = jest
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('boom')))
        .mockReturnValueOnce(of({ data: fileBuffer }));
      const getFile = jest.fn().mockResolvedValue({ file_path: 'photos/a.jpg' });
      hashMock.mockResolvedValue('ALT_HASH');
      const { service } = setup({ httpGet, getFile, tgEnv: 'test' });

      await expect(
        service.getPostImageHash([{ file_id: 'f', height: 500 } as any])
      ).resolves.toBe('ALT_HASH');

      expect(httpGet).toHaveBeenNthCalledWith(
        1,
        'https://api.telegram.org/file/botTOKEN/test/photos/a.jpg',
        { responseType: 'arraybuffer' }
      );
      expect(httpGet).toHaveBeenNthCalledWith(
        2,
        'https://api.telegram.org/file/botTOKEN/photos/a.jpg',
        {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' },
        }
      );
    });

    it('возвращает null, если в test-среде упали оба способа', async () => {
      const httpGet = jest.fn().mockReturnValue(throwError(() => new Error('down')));
      const getFile = jest.fn().mockResolvedValue({ file_path: 'photos/a.jpg' });
      const { service } = setup({ httpGet, getFile, tgEnv: 'test' });

      await expect(
        service.getPostImageHash([{ file_id: 'f', height: 500 } as any])
      ).resolves.toBeNull();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('Alternative method also failed'),
        expect.anything()
      );
    });

    it('в prod после сбоя скачивания возвращает null без альтернативы', async () => {
      const httpGet = jest.fn().mockReturnValue(throwError(() => new Error('down')));
      const getFile = jest.fn().mockResolvedValue({ file_path: 'photos/a.jpg' });
      const { service } = setup({ httpGet, getFile, tgEnv: 'prod' });

      await expect(
        service.getPostImageHash([{ file_id: 'f', height: 500 } as any])
      ).resolves.toBeNull();
      expect(httpGet).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('Error fetching image file'),
        expect.anything()
      );
    });

    it('ловит ошибку внешнего блока (getFile падает) и возвращает null', async () => {
      const getFile = jest.fn().mockRejectedValue(new Error('api down'));
      const { service } = setup({ getFile });

      await expect(
        service.getPostImageHash([{ file_id: 'f', height: 500 } as any])
      ).resolves.toBeNull();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in getPostImageHash: api down'),
        expect.anything()
      );
    });

    it('generateSyntheticHash строит 16-символьный hex из file_id и пишет warn', () => {
      const { service } = setup();
      const result = (service as any).generateSyntheticHash('abc');

      expect(result).toBe(Buffer.from('abc').toString('hex').substring(0, 16));
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Using synthetic hash for file_id: abc')
      );
    });
  });
});
