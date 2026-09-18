import { CringeManagementService } from './cringe-management.service';

function makeRepo(): any {
  return { find: jest.fn(), update: jest.fn() };
}

function makeBot(): any {
  return {
    api: { copyMessage: jest.fn(), deleteMessage: jest.fn() },
  };
}

function makeConfig(): any {
  return { cringeMemeChannelId: 300, memeChanelId: 100 };
}

function makeService(repo = makeRepo(), bot = makeBot(), config = makeConfig()) {
  return { service: new CringeManagementService(config, bot, repo), repo, bot, config };
}

describe('CringeManagementService', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('отдаёт переданный репозиторий через getter', () => {
    const { service, repo } = makeService();

    expect(service.repository).toBe(repo);
  });

  describe('moveCringeMessages', () => {
    it('ничего не делает, если подходящих постов нет', async () => {
      const { service, repo, bot } = makeService();
      repo.find.mockResolvedValue([]);

      await service.moveCringeMessages();

      expect(repo.find).toHaveBeenCalledWith({
        where: { isMovedToCringe: false, memeChannelMessageId: expect.anything() },
      });
      expect(bot.api.copyMessage).not.toHaveBeenCalled();
    });

    it('не падает, если репозиторий вернул null', async () => {
      const { service, repo, bot } = makeService();
      repo.find.mockResolvedValue(null);

      await expect(service.moveCringeMessages()).resolves.toBeUndefined();
      expect(bot.api.copyMessage).not.toHaveBeenCalled();
    });

    it('копирует пост в кринж-канал, помечает и удаляет оригинал', async () => {
      const { service, repo, bot, config } = makeService();
      repo.find.mockResolvedValue([{ memeChannelMessageId: 11 }]);
      bot.api.copyMessage.mockResolvedValue({ message_id: 900 });
      repo.update.mockResolvedValue({ affected: 1 });

      await service.moveCringeMessages();

      expect(bot.api.copyMessage).toHaveBeenCalledWith(
        config.cringeMemeChannelId,
        config.memeChanelId,
        11,
        { disable_notification: true }
      );
      expect(repo.update).toHaveBeenCalledWith(
        { memeChannelMessageId: 11 },
        { isMovedToCringe: true, cringeChannelMessageId: 900 }
      );
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(config.memeChanelId, 11);
    });

    it('проставляет null, если у скопированного сообщения нет id', async () => {
      const { service, repo, bot } = makeService();
      repo.find.mockResolvedValue([{ memeChannelMessageId: 12 }]);
      bot.api.copyMessage.mockResolvedValue({});
      repo.update.mockResolvedValue({ affected: 1 });

      await service.moveCringeMessages();

      expect(repo.update).toHaveBeenCalledWith(
        { memeChannelMessageId: 12 },
        { isMovedToCringe: true, cringeChannelMessageId: null }
      );
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(100, 12);
    });

    it('обрабатывает несколько постов подряд', async () => {
      const { service, repo, bot } = makeService();
      repo.find.mockResolvedValue([
        { memeChannelMessageId: 1 },
        { memeChannelMessageId: 2 },
      ]);
      bot.api.copyMessage
        .mockResolvedValueOnce({ message_id: 101 })
        .mockResolvedValueOnce({ message_id: 102 });
      repo.update.mockResolvedValue({ affected: 1 });

      await service.moveCringeMessages();

      expect(bot.api.copyMessage).toHaveBeenCalledTimes(2);
      expect(bot.api.deleteMessage).toHaveBeenNthCalledWith(1, 100, 1);
      expect(bot.api.deleteMessage).toHaveBeenNthCalledWith(2, 100, 2);
    });

    it('при ошибке копирования логирует, помечает пост и останавливается', async () => {
      const { service, repo, bot } = makeService();
      repo.find.mockResolvedValue([
        { memeChannelMessageId: 21 },
        { memeChannelMessageId: 22 },
      ]);
      bot.api.copyMessage.mockRejectedValue(new Error('copy fail'));
      repo.update.mockResolvedValue({ affected: 1 });

      await service.moveCringeMessages();

      expect(console.error).toHaveBeenCalledWith('[Error while copy message]', expect.any(Error));
      expect(repo.update).toHaveBeenCalledWith(
        { memeChannelMessageId: 21 },
        { isMovedToCringe: true, cringeChannelMessageId: null }
      );
      expect(bot.api.copyMessage).toHaveBeenCalledTimes(1);
      expect(bot.api.deleteMessage).not.toHaveBeenCalled();
    });
  });
});
