import {
  MattermostPostSenderInterface,
  sendPostToMattermost,
} from './mattermost-post';

describe('sendPostToMattermost', () => {
  const buildMattermost = (): MattermostPostSenderInterface => ({
    sendPostWithFile: jest.fn().mockResolvedValue(undefined),
  });

  const buildLogger = () => ({ error: jest.fn() });

  it('получает ссылку на файл и отправляет пост с префиксом имени', async () => {
    const mattermostService = buildMattermost();
    const logger = buildLogger();
    const getFileUrl = jest.fn().mockResolvedValue('https://file');

    await sendPostToMattermost({
      mattermostService,
      getFileUrl,
      logger,
      requestChannelMessageId: 5,
      caption: 'подпись',
      fileNamePrefix: 'meme_',
    });

    expect(getFileUrl).toHaveBeenCalledWith(5);
    expect(mattermostService.sendPostWithFile).toHaveBeenCalledWith({
      message: 'подпись',
      fileUrl: 'https://file',
      fileName: 'meme_5',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('логирует ошибку и не пробрасывает её', async () => {
    const mattermostService = buildMattermost();
    const logger = buildLogger();
    const error = new Error('mm down');
    const getFileUrl = jest.fn().mockRejectedValue(error);

    await expect(
      sendPostToMattermost({
        mattermostService,
        getFileUrl,
        logger,
        requestChannelMessageId: 11,
        caption: 'x',
        fileNamePrefix: 'observatory_meme_',
      })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('Failed to send to Mattermost:', error);
    expect(mattermostService.sendPostWithFile).not.toHaveBeenCalled();
  });
});
