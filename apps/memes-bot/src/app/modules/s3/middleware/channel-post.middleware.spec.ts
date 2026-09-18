jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));

import { Logger } from '@nestjs/common';
import { ChannelPostMiddleware } from './channel-post.middleware';

function createMiddleware() {
  const memeUploadService = { handleChannelPost: jest.fn().mockResolvedValue(undefined) };
  const middleware = new ChannelPostMiddleware(memeUploadService as any);
  return { middleware, memeUploadService };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ChannelPostMiddleware.middleware', () => {
  it('передаёт пост с фото в MemeUploadService и вызывает next', async () => {
    const { middleware, memeUploadService } = createMiddleware();
    const handler = middleware.middleware();
    const ctx: any = { channelPost: { chat: { id: -1001 }, photo: [{ file_id: 'f' }] } };
    const next = jest.fn().mockResolvedValue(undefined);

    await handler(ctx, next);

    expect(memeUploadService.handleChannelPost).toHaveBeenCalledWith(ctx);
    expect(next).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Processing channel post from chat -1001'
    );
  });

  it('не передаёт пост без фото, но вызывает next', async () => {
    const { middleware, memeUploadService } = createMiddleware();
    const handler = middleware.middleware();
    const ctx: any = { channelPost: { chat: { id: -1001 }, photo: undefined } };
    const next = jest.fn().mockResolvedValue(undefined);

    await handler(ctx, next);

    expect(memeUploadService.handleChannelPost).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('пропускает контекст без channelPost, не логируя его', async () => {
    const { middleware, memeUploadService } = createMiddleware();
    const handler = middleware.middleware();
    const ctx: any = { message: { text: 'hi' } };
    const next = jest.fn().mockResolvedValue(undefined);

    await handler(ctx, next);

    expect(memeUploadService.handleChannelPost).not.toHaveBeenCalled();
    expect(Logger.prototype.log).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('не вызывает next, если обработчик поста падает', async () => {
    const { middleware, memeUploadService } = createMiddleware();
    memeUploadService.handleChannelPost.mockRejectedValue(new Error('boom'));
    const handler = middleware.middleware();
    const ctx: any = { channelPost: { chat: { id: -1002 }, photo: [{ file_id: 'f' }] } };
    const next = jest.fn().mockResolvedValue(undefined);

    await expect(handler(ctx, next)).rejects.toThrow('boom');

    expect(next).not.toHaveBeenCalled();
  });
});
