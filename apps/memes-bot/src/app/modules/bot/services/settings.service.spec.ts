import { SettingsService } from './settings.service';

function makeRepo(): any {
  return { findOne: jest.fn() };
}

function makeBot(): any {
  return { api: { getChat: jest.fn() } };
}

function makeConfig(): any {
  return { memeChanelId: 100, bestMemeChanelId: 200, cringeMemeChannelId: 300 };
}

function makeService(repo = makeRepo(), bot = makeBot(), config = makeConfig()) {
  return { service: new SettingsService(repo, bot, config), repo, bot, config };
}

describe('SettingsService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ищет настройки канала по заполненной ссылке, свежайшие первыми', async () => {
    const { service, repo, bot } = makeService();
    bot.api.getChat.mockResolvedValue({ username: 'main' });
    repo.findOne.mockResolvedValue({ joinLink: 'https://join' });

    await service.channelLinkUrl();

    expect(bot.api.getChat).toHaveBeenCalledWith(100);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { joinLink: expect.anything() },
      order: { id: 'DESC' },
    });
  });

  describe('channelLinkUrl', () => {
    it('строит ссылку по username канала, если настроек нет', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'main' });
      repo.findOne.mockResolvedValue(null);

      await expect(service.channelLinkUrl()).resolves.toBe('https://t.me/main');
    });

    it('использует invite_link для приватного канала', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ invite_link: 'https://t.me/+abc' });
      repo.findOne.mockResolvedValue(null);

      await expect(service.channelLinkUrl()).resolves.toBe('https://t.me/+abc');
    });

    it('настроенный joinLink имеет приоритет над данными канала', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'main' });
      repo.findOne.mockResolvedValue({ joinLink: 'https://custom' });

      await expect(service.channelLinkUrl()).resolves.toBe('https://custom');
    });
  });

  describe('channelBestLinkUrl', () => {
    it('берёт username лучшего канала', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'best' });
      repo.findOne.mockResolvedValue(undefined);

      await expect(service.channelBestLinkUrl()).resolves.toBe('https://t.me/best');
      expect(bot.api.getChat).toHaveBeenCalledWith(200);
    });

    it('для приватного лучшего канала берёт invite_link', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ invite_link: 'https://t.me/+best' });
      repo.findOne.mockResolvedValue(null);

      await expect(service.channelBestLinkUrl()).resolves.toBe('https://t.me/+best');
    });

    it('настроенный joinLink лучшего канала имеет приоритет', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'best' });
      repo.findOne.mockResolvedValue({ joinLink: 'https://best-join' });

      await expect(service.channelBestLinkUrl()).resolves.toBe('https://best-join');
    });
  });

  describe('channelBestChannelName', () => {
    it('отдаёт title канала', async () => {
      const { service, bot } = makeService();
      bot.api.getChat.mockResolvedValue({ title: 'Лучшее', username: 'best' });

      await expect(service.channelBestChannelName()).resolves.toBe('Лучшее');
      expect(bot.api.getChat).toHaveBeenCalledWith(200);
    });

    it('без title падает на username', async () => {
      const { service, bot } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'best' });

      await expect(service.channelBestChannelName()).resolves.toBe('best');
    });

    it('без title и username отдаёт значение по умолчанию', async () => {
      const { service, bot } = makeService();
      bot.api.getChat.mockResolvedValue({});

      await expect(service.channelBestChannelName()).resolves.toBe('Лучшие мемы за сутки');
    });
  });

  describe('cringeChannelHtmlLink', () => {
    it('делает HTML-ссылку с title для публичного канала', async () => {
      const { service, bot } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'cringe', title: 'Кринж' });

      await expect(service.cringeChannelHtmlLink()).resolves.toBe(
        '<a href="https://t.me/cringe">Кринж</a>'
      );
      expect(bot.api.getChat).toHaveBeenCalledWith(300);
    });

    it('для приватного канала берёт invite_link', async () => {
      const { service, bot } = makeService();
      bot.api.getChat.mockResolvedValue({ invite_link: 'https://t.me/+cr', title: 'Кринж' });

      await expect(service.cringeChannelHtmlLink()).resolves.toBe(
        '<a href="https://t.me/+cr">Кринж</a>'
      );
    });
  });

  describe('channelHtmlLinkIfPrivate', () => {
    it('возвращает ссылку, когда заданы и joinLink, и постLinkText', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({
        joinLink: 'https://join',
        postLinkText: 'Подписаться',
      });

      await expect(service.channelHtmlLinkIfPrivate()).resolves.toBe(
        '<a href="https://join">Подписаться</a>'
      );
    });

    it('возвращает пустую строку без настроек', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue(null);

      await expect(service.channelHtmlLinkIfPrivate()).resolves.toBe('');
    });

    it('возвращает пустую строку, если не задан текст ссылки', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ joinLink: 'https://join' });

      await expect(service.channelHtmlLinkIfPrivate()).resolves.toBe('');
    });

    it('возвращает пустую строку, если не задана сама ссылка', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ postLinkText: 'Подписаться' });

      await expect(service.channelHtmlLinkIfPrivate()).resolves.toBe('');
    });
  });

  describe('channelHtmlLink', () => {
    it('использует данные канала, если настроек нет', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'main', title: 'Мемы' });
      repo.findOne.mockResolvedValue(null);

      await expect(service.channelHtmlLink()).resolves.toBe(
        '<a href="https://t.me/main">Мемы</a>'
      );
      expect(bot.api.getChat).toHaveBeenCalledWith(100);
    });

    it('настроенные joinLink и postLinkText перекрывают канал', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'main', title: 'Мемы' });
      repo.findOne.mockResolvedValue({ joinLink: 'https://join', postLinkText: 'Вступить' });

      await expect(service.channelHtmlLink()).resolves.toBe(
        '<a href="https://join">Вступить</a>'
      );
    });

    it('при наличии только joinLink берёт title канала', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ invite_link: 'https://t.me/+x', title: 'Мемы' });
      repo.findOne.mockResolvedValue({ joinLink: 'https://join' });

      await expect(service.channelHtmlLink()).resolves.toBe(
        '<a href="https://join">Мемы</a>'
      );
    });

    it('при наличии только postLinkText берёт ссылку канала', async () => {
      const { service, bot, repo } = makeService();
      bot.api.getChat.mockResolvedValue({ username: 'main', title: 'Мемы' });
      repo.findOne.mockResolvedValue({ postLinkText: 'Вступить' });

      await expect(service.channelHtmlLink()).resolves.toBe(
        '<a href="https://t.me/main">Вступить</a>'
      );
    });
  });
});
