import { Logger } from '@nestjs/common';

const mockPost = jest.fn();
const mockGet = jest.fn();
const mockCreate = jest.fn((..._args: any[]) => ({ post: mockPost, get: mockGet }));

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: (...args: any[]) => mockCreate(...args),
    get: (...args: any[]) => mockGet(...args),
  },
}));

import * as FormData from 'form-data';
import { MattermostService } from './mattermost.service';

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    mattermostBaseUrl: 'https://time.test',
    mattermostToken: 'token-123',
    mattermostChannelId: 'channel-42',
    ...overrides,
  };
}

function makeService(config: any = makeConfig()): MattermostService {
  return new MattermostService(config);
}

describe('MattermostService', () => {
  let appendSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockCreate.mockReset();
    mockCreate.mockReturnValue({ post: mockPost, get: mockGet });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    appendSpy = jest.spyOn((FormData as any).prototype, 'append');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('конструктор', () => {
    it('создаёт axios-клиент с baseURL и Bearer-токеном', () => {
      makeService(makeConfig({ mattermostBaseUrl: 'https://mm.example', mattermostToken: 'abc' }));

      expect(mockCreate).toHaveBeenCalledWith({
        baseURL: 'https://mm.example',
        headers: { Authorization: 'Bearer abc' },
      });
    });
  });

  describe('sendPostWithFile', () => {
    it('без fileUrl публикует пост с пустым file_ids и логирует успех', async () => {
      mockPost.mockResolvedValueOnce({ data: {} });
      const service = makeService();

      await service.sendPostWithFile({ message: 'привет из TG' });

      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'привет из TG',
        file_ids: [],
      });
      expect(Logger.prototype.log).toHaveBeenCalledWith('Post sent to Mattermost successfully');
    });

    it('пустое сообщение заменяет на пустую строку', async () => {
      mockPost.mockResolvedValueOnce({ data: {} });
      const service = makeService();

      await service.sendPostWithFile({ message: undefined as any });

      expect(mockPost).toHaveBeenCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: '',
        file_ids: [],
      });
    });

    it('с fileUrl скачивает файл, загружает его и прикрепляет file_ids к посту', async () => {
      mockGet.mockResolvedValueOnce({
        data: Buffer.from('image-bytes'),
        headers: { 'content-type': 'image/png' },
      });
      mockPost
        .mockResolvedValueOnce({ data: { file_infos: [{ id: 'file-1' }, { id: 'file-2' }] } })
        .mockResolvedValueOnce({ data: { id: 'post-1' } });
      const service = makeService();

      await service.sendPostWithFile({
        message: 'мем',
        fileUrl: 'https://api.telegram.org/file/botTOKEN/photo.png',
        fileName: 'meme',
      });

      expect(mockGet).toHaveBeenCalledWith('https://api.telegram.org/file/botTOKEN/photo.png', {
        responseType: 'arraybuffer',
      });

      const filesCall = mockPost.mock.calls[0];
      expect(filesCall[0]).toBe('/api/v4/files');
      expect(filesCall[1]).toBeInstanceOf((FormData as any));
      expect(filesCall[2]).toEqual({ headers: expect.any(Object) });

      expect(mockPost).toHaveBeenLastCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'мем',
        file_ids: ['file-1', 'file-2'],
      });

      const filesAppend = appendSpy.mock.calls.find((call) => call[0] === 'files')!;
      expect(filesAppend[1]).toEqual(Buffer.from('image-bytes'));
      expect(filesAppend[2]).toMatchObject({ filename: 'meme.png', contentType: 'image/png' });
      expect(appendSpy).toHaveBeenCalledWith('channel_id', 'channel-42');
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        `Upload response data: ${JSON.stringify({ file_infos: [{ id: 'file-1' }, { id: 'file-2' }] })}`
      );
    });

    it('отсутствие file_infos в ответе загрузки даёт пустой файловый список', async () => {
      mockGet.mockResolvedValueOnce({
        data: Buffer.from('x'),
        headers: { 'content-type': 'image/jpeg' },
      });
      mockPost.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: {} });
      const service = makeService();

      await service.sendPostWithFile({ message: 'мем', fileUrl: 'https://tg/file' });

      expect(mockPost).toHaveBeenLastCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'мем',
        file_ids: [],
      });
      const filesAppend = appendSpy.mock.calls.find((call) => call[0] === 'files')!;
      expect(filesAppend[2]).toMatchObject({ filename: 'meme.jpg' });
    });

    it('null в data ответа загрузки тоже даёт пустой файловый список', async () => {
      mockGet.mockResolvedValueOnce({
        data: Buffer.from('x'),
        headers: { 'content-type': 'image/png' },
      });
      mockPost.mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: {} });
      const service = makeService();

      await service.sendPostWithFile({ message: 'мем', fileUrl: 'https://tg/file' });

      expect(mockPost).toHaveBeenLastCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'мем',
        file_ids: [],
      });
    });

    it('ошибка публикации поста перехватывается и логируется (не пробрасывается)', async () => {
      mockPost.mockRejectedValueOnce(new Error('mm down'));
      const service = makeService();

      await expect(service.sendPostWithFile({ message: 'мем' })).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to send post to Mattermost:',
        expect.any(Error)
      );
    });
  });

  describe('определение расширения файла', () => {
    async function uploadWith(opts: { fileUrl: string; headers: any; fileName?: string }) {
      mockGet.mockResolvedValueOnce({ data: Buffer.from('x'), headers: opts.headers });
      mockPost.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: {} });
      const service = makeService();

      await service.sendPostWithFile({
        message: 'm',
        fileUrl: opts.fileUrl,
        fileName: opts.fileName,
      });

      const filesAppend = appendSpy.mock.calls.find((call) => call[0] === 'files')!;
      return filesAppend[2].filename as string;
    }

    it.each([
      ['https://tg/photo.JPG', 'image/jpeg', '.jpg'],
      ['https://tg/photo.jpeg', 'image/jpeg', '.jpeg'],
      ['https://tg/photo.png?x=1', 'image/png', '.png'],
      ['https://tg/photo.gif', 'image/gif', '.gif'],
      ['https://tg/photo.webp', 'image/webp', '.webp'],
      ['https://tg/clip.mp4', 'video/mp4', '.mp4'],
      ['https://tg/clip.mov', 'video/quicktime', '.mov'],
    ])('берёт расширение из URL %s', async (fileUrl, contentType, expectedExt) => {
      const filename = await uploadWith({
        fileUrl,
        headers: { 'content-type': contentType },
        fileName: 'media',
      });

      expect(filename).toBe(`media${expectedExt}`);
    });

    it.each([
      ['image/jpeg', '.jpg'],
      ['application/jpg', '.jpg'],
      ['image/png', '.png'],
      ['image/gif', '.gif'],
      ['image/webp', '.webp'],
    ])('берёт расширение из content-type %s', async (contentType, expectedExt) => {
      const filename = await uploadWith({
        fileUrl: 'https://tg/download',
        headers: { 'content-type': contentType },
        fileName: 'media',
      });

      expect(filename).toBe(`media${expectedExt}`);
    });

    it('без совпадений и без fileName отдаёт meme без расширения', async () => {
      const filename = await uploadWith({
        fileUrl: 'https://tg/download',
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(filename).toBe('meme');
    });

    it('при отсутствии content-type использует octet-stream и не добавляет расширение', async () => {
      const filename = await uploadWith({
        fileUrl: 'https://tg/download',
        headers: {},
        fileName: 'meme',
      });

      expect(filename).toBe('meme');
    });
  });

  describe('ошибка загрузки файла', () => {
    it('возвращает пустой file_ids и логирует ошибку, продолжая публикацию', async () => {
      mockGet.mockRejectedValueOnce(new Error('network'));
      mockPost.mockResolvedValueOnce({ data: {} });
      const service = makeService();

      await service.sendPostWithFile({
        message: 'мем',
        fileUrl: 'https://tg/broken',
        fileName: 'meme',
      });

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Failed to upload file to Mattermost:',
        expect.any(Error)
      );
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/api/v4/posts', {
        channel_id: 'channel-42',
        message: 'мем',
        file_ids: [],
      });
    });
  });
});
