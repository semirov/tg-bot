import { Logger } from '@nestjs/common';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { ClientBaseService } from './client-base.service';

const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

function validSessionString(): string {
  const address = Buffer.from('1.1.1.1');
  const addressLength = Buffer.alloc(2);
  addressLength.writeInt16BE(address.length, 0);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443, 0);
  return (
    '1' +
    Buffer.concat([Buffer.from([2]), addressLength, address, port, Buffer.alloc(256, 1)]).toString(
      'base64'
    )
  );
}

function makeRepo() {
  return {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    countBy: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function makeBot() {
  return {
    api: {
      sendMessage: jest.fn().mockResolvedValue({}),
      copyMessage: jest.fn(),
      getMe: jest.fn().mockResolvedValue({ id: 999, username: 'test_bot' }),
    },
    use: jest.fn(),
    callbackQuery: jest.fn(),
    on: jest.fn(),
  };
}

function makeConfig() {
  return {
    appApiId: 111,
    appApiHash: 'hash',
    ownerId: 42,
    memeChanelId: -1001000000001,
    cringeMemeChannelId: -1001000000002,
    userRequestMemeChannel: -1001000000003,
    bestMemeChanelId: -1001000000004,
    parserUserId: 4242,
  };
}

function setup() {
  const repo = makeRepo();
  const bot = makeBot();
  const config = makeConfig();
  const service = new ClientBaseService(config as any, bot as any, repo as any);
  return { service, repo, bot, config };
}

function urlEntity(offset: number, length: number) {
  return new Api.MessageEntityUrl({ offset, length });
}

function textUrlEntity(url: string) {
  return new Api.MessageEntityTextUrl({ offset: 0, length: 1, url });
}

function mediaDocument(mimeType: string) {
  const document = new Api.Document({
    id: bigInt(1) as any,
    accessHash: bigInt(1) as any,
    fileReference: Buffer.alloc(0),
    date: 0,
    mimeType,
    size: bigInt(1) as any,
    dcId: 1,
    attributes: [],
  });
  return new Api.MessageMediaDocument({ document });
}

describe('ClientBaseService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('onModuleInit', () => {
    it('регистрирует беседы и команды, но не запускает обсерваторию без активной сессии', async () => {
      const { service, repo, bot } = setup();
      repo.countBy.mockResolvedValue(1);
      repo.findOne.mockResolvedValue({ isActive: false });

      await service.onModuleInit();

      expect(bot.use).toHaveBeenCalledTimes(3);
      expect(bot.callbackQuery).toHaveBeenCalledTimes(3);
      expect(bot.on).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalledWith({ station: 'main' }, { isActive: true });
    });

    it('создаёт пустую запись сессии, если её ещё нет', async () => {
      const { service, repo } = setup();
      repo.countBy.mockResolvedValue(0);
      repo.findOne.mockResolvedValue({ isActive: false });

      await service.onModuleInit();

      expect(repo.create).toHaveBeenCalledWith({
        station: 'main',
        session: '',
        isActive: false,
      });
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('getters', () => {
    it('bestMemesDaily$ отдаёт значения из внутреннего субъекта', () => {
      const { service } = setup();
      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      (service as any).bestMemesDailytSubject.next({ byViewPostMemeId: 5 });
      expect(received).toEqual([{ byViewPostMemeId: 5 }]);
    });
  });

  describe('toggleChannelObserver', () => {
    it('останавливает станцию, если обсерватория активна', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValue({ isActive: true });
      const destroy = jest.fn().mockResolvedValue(undefined);
      (service as any).telegramClient = { connected: true, destroy };

      await service.toggleChannelObserver();

      expect(destroy).toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { isActive: false });
    });

    it('запускает станцию, если обсерватория выключена', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValue({ isActive: false });
      const startSpy = jest
        .spyOn(TelegramClient.prototype, 'start')
        .mockResolvedValue(undefined as any);
      jest.spyOn(TelegramClient.prototype, 'addEventHandler').mockImplementation((() => undefined) as any);

      await service.toggleChannelObserver();

      expect(startSpy).toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { isActive: true });
    });

    it('не уничтожает клиент, если он не подключён', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValue({ isActive: true });
      const destroy = jest.fn();
      (service as any).telegramClient = { connected: false, destroy };

      await service.toggleChannelObserver();

      expect(destroy).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { isActive: false });
    });
  });

  describe('startChannelObserver', () => {
    it('запускает клиент, сохраняет сессию и подписывается на события', async () => {
      const { service, repo, bot } = setup();
      repo.findOne.mockResolvedValue({ session: validSessionString(), isActive: false });
      const startSpy = jest
        .spyOn(TelegramClient.prototype, 'start')
        .mockResolvedValue(undefined as any);
      const addSpy = jest
        .spyOn(TelegramClient.prototype, 'addEventHandler')
        .mockImplementation((() => undefined) as any);

      await (service as any).startChannelObserver();
      await flush();

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { isActive: true });
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { session: '' });

      const options = startSpy.mock.calls[0][0] as any;

      const phone = options.phoneNumber();
      await flush();
      (service as any).phoneSubject.next('+79990000000');
      await expect(phone).resolves.toBe('+79990000000');
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        'Нужен номер телефона для запуска клиента',
        expect.objectContaining({ reply_markup: expect.anything() })
      );

      const password = options.password();
      await flush();
      (service as any).passwordSubject.next('secret');
      await expect(password).resolves.toBe('secret');

      const code = options.phoneCode();
      await flush();
      (service as any).phoneCodeSubject.next('12345');
      await expect(code).resolves.toBe('12345');

      expect(() => options.onError(new Error('boom'))).not.toThrow();

      const onMessageSpy = jest
        .spyOn(service as any, 'onMessageEvent')
        .mockResolvedValue(undefined);
      const eventHandler = addSpy.mock.calls[0][0] as any;
      await eventHandler({ isChannel: false });
      expect(onMessageSpy).toHaveBeenCalledWith({ isChannel: false });
    });

    it('создаёт пустую сессию, если сохранённая не найдена', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValue(null);
      const startSpy = jest
        .spyOn(TelegramClient.prototype, 'start')
        .mockResolvedValue(undefined as any);
      jest.spyOn(TelegramClient.prototype, 'addEventHandler').mockImplementation((() => undefined) as any);

      await (service as any).startChannelObserver();
      await flush();

      expect(startSpy).toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { session: '' });
    });
  });

  describe('getPhoneNumber / getPassword / getPhoneCode', () => {
    it.each([
      ['getPhoneNumber', 'phoneSubject', 'Нужен номер телефона для запуска клиента'],
      ['getPassword', 'passwordSubject', 'Нужен пароль для запуска клиента'],
      ['getPhoneCode', 'phoneCodeSubject', 'Нужен код подтверждения для запуска клиента'],
    ])('%s шлёт запрос владельцу и ждёт ответа', async (method, subject, text) => {
      const { service, bot } = setup();

      const promise = (service as any)[method]();
      await flush();
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        text,
        expect.objectContaining({ reply_markup: expect.anything() })
      );
      (service as any)[subject].next('answer');

      await expect(promise).resolves.toBe('answer');
    });
  });

  describe('conversations', () => {
    it('phoneConversation пересылает текст ответа в phoneSubject', async () => {
      const { service } = setup();
      const reply = jest.fn().mockResolvedValue(undefined);
      const conversation = { wait: jest.fn().mockResolvedValue({ message: { text: '123' } }) };
      const nextSpy = jest.spyOn((service as any).phoneSubject, 'next');

      await service.phoneConversation(conversation as any, { reply } as any);

      expect(reply).toHaveBeenCalledWith('Введи номер телефона');
      expect(nextSpy).toHaveBeenCalledWith('123');
    });

    it('passwordConversation пересылает текст ответа в passwordSubject', async () => {
      const { service } = setup();
      const conversation = { wait: jest.fn().mockResolvedValue({ message: { text: 'pw' } }) };
      const nextSpy = jest.spyOn((service as any).passwordSubject, 'next');

      await service.passwordConversation(conversation as any, { reply: jest.fn() } as any);

      expect(nextSpy).toHaveBeenCalledWith('pw');
    });

    it('phoneCodeConversation пересылает текст ответа в phoneCodeSubject', async () => {
      const { service } = setup();
      const conversation = { wait: jest.fn().mockResolvedValue({ message: { text: '999' } }) };
      const nextSpy = jest.spyOn((service as any).phoneCodeSubject, 'next');

      await service.phoneCodeConversation(conversation as any, { reply: jest.fn() } as any);

      expect(nextSpy).toHaveBeenCalledWith('999');
    });

    it.each(['phoneConversation', 'passwordConversation', 'phoneCodeConversation'])(
      '%s игнорирует ответ без текста',
      async (method) => {
        const { service } = setup();
        const subject =
          method === 'phoneConversation'
            ? 'phoneSubject'
            : method === 'passwordConversation'
              ? 'passwordSubject'
              : 'phoneCodeSubject';
        const nextSpy = jest.spyOn((service as any)[subject], 'next');

        for (const value of [undefined, {}, { message: {} }]) {
          const conversation = { wait: jest.fn().mockResolvedValue(value) };
          await (service as any)[method](conversation as any, { reply: jest.fn() } as any);
        }

        expect(nextSpy).not.toHaveBeenCalled();
      }
    );
  });

  describe('waitingClientCommands', () => {
    it('входит в нужную беседу по каждому callback', async () => {
      const { service, bot } = setup();
      const callbacks: Record<string, any> = {};
      bot.callbackQuery.mockImplementation((trigger: string, cb: any) => {
        callbacks[trigger] = cb;
      });

      (service as any).waitingClientCommands();

      const enter = jest.fn();
      await callbacks['fill_client_phone']({ conversation: { enter } });
      await callbacks['fill_client_password']({ conversation: { enter } });
      await callbacks['fill_client_code']({ conversation: { enter } });

      expect(enter.mock.calls.map((call) => call[0])).toEqual([
        'PHONE_CONVERSATION',
        'PASSWORD_CONVERSATION',
        'PHONE_CODE_CONVERSATION',
      ]);
    });
  });

  describe('registerConversations', () => {
    it('подключает три conversation-мидлвари', () => {
      const { service, bot } = setup();

      (service as any).registerConversations();

      expect(bot.use).toHaveBeenCalledTimes(3);
    });
  });

  describe('saveSession / lastObserverStatus / changeObserverState / loadSession', () => {
    it('saveSession обновляет запись main', async () => {
      const { service, repo } = setup();
      await (service as any).saveSession('sess');
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { session: 'sess' });
    });

    it('lastObserverStatus отражает флаг isActive', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValueOnce({ isActive: true });
      await expect(service.lastObserverStatus()).resolves.toBe(true);

      repo.findOne.mockResolvedValueOnce({ isActive: false });
      await expect(service.lastObserverStatus()).resolves.toBe(false);

      repo.findOne.mockResolvedValueOnce(undefined);
      await expect(service.lastObserverStatus()).resolves.toBe(false);
    });

    it('changeObserverState пишет статус в репозиторий', async () => {
      const { service, repo } = setup();
      await (service as any).changeObserverState(true);
      expect(repo.update).toHaveBeenCalledWith({ station: 'main' }, { isActive: true });
    });

    it('loadSession возвращает пустую сессию при отсутствии записи', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValue(null);
      const session = await (service as any).loadSession();
      expect(session.save()).toBe('');
    });

    it('loadSession восстанавливает сохранённую сессию', async () => {
      const { service, repo } = setup();
      repo.findOne.mockResolvedValue({ session: validSessionString() });
      const session = await (service as any).loadSession();
      expect(session.dcId).toBe(2);
      expect(session.serverAddress).toBe('1.1.1.1');
    });
  });

  describe('checkAutoRunObserver', () => {
    it('создаёт дефолтную сессию и не запускает клиент', async () => {
      const { service, repo } = setup();
      repo.countBy.mockResolvedValue(0);
      repo.findOne.mockResolvedValue({ isActive: false });
      const startSpy = jest.spyOn(service as any, 'startChannelObserver').mockResolvedValue(undefined);

      await (service as any).checkAutoRunObserver();

      expect(repo.create).toHaveBeenCalledWith({ station: 'main', session: '', isActive: false });
      expect(repo.save).toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('запускает клиент, если observer был активен', async () => {
      const { service, repo } = setup();
      repo.countBy.mockResolvedValue(1);
      repo.findOne.mockResolvedValue({ isActive: true });
      const startSpy = jest.spyOn(service as any, 'startChannelObserver').mockResolvedValue(undefined);

      await (service as any).checkAutoRunObserver();

      expect(repo.create).not.toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });
  });

  describe('handleAlbum', () => {
    it('возвращает false для одиночного сообщения без groupedId', async () => {
      const { service } = setup();
      const event = { message: {} };
      await expect((service as any).handleAlbum(event)).resolves.toBe(false);
    });

    it('пересылает альбом боту, если это не реклама', async () => {
      jest.useFakeTimers();
      const { service } = setup();
      jest.spyOn(service as any, 'isAdPost').mockResolvedValue(false);
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        message: {
          groupedId: { toString: () => '777' },
          photo: [{ file_id: 'p' }],
          forwardTo,
        },
      };

      await expect((service as any).handleAlbum(event)).resolves.toBe(true);
      jest.advanceTimersByTime(800);
      await flush();
      await flush();

      expect(forwardTo).toHaveBeenCalledWith('@test_bot');
      expect((service as any).lastProcessedGroup).toBeUndefined();
    });

    it('не пересылает альбом-рекламу', async () => {
      jest.useFakeTimers();
      const { service } = setup();
      jest.spyOn(service as any, 'isAdPost').mockResolvedValue(true);
      const forwardTo = jest.fn();
      const event = {
        message: {
          groupedId: { toString: () => '888' },
          forwardTo,
        },
      };

      await (service as any).handleAlbum(event);
      jest.advanceTimersByTime(800);
      await flush();
      await flush();

      expect(forwardTo).not.toHaveBeenCalled();
    });

    it('сбрасывает таймер при повторном сообщении той же группы', async () => {
      jest.useFakeTimers();
      const { service } = setup();
      jest.spyOn(service as any, 'isAdPost').mockResolvedValue(false);
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      (service as any).lastProcessedGroup = { id: '999', timer: 123 as any };
      const event = {
        message: { groupedId: { toString: () => '999' }, photo: [{ file_id: 'p' }], forwardTo: jest.fn() },
      };

      await (service as any).handleAlbum(event);

      expect(clearSpy).toHaveBeenCalledWith(123);
      jest.advanceTimersByTime(800);
      await flush();
    });
  });

  describe('onMessageEvent', () => {
    it('игнорирует не-каналы', async () => {
      const { service } = setup();
      const handleSpy = jest.spyOn(service as any, 'handleAlbum');
      await (service as any).onMessageEvent({ isChannel: false });
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('игнорирует собственные каналы', async () => {
      const { service, config } = setup();
      const handleSpy = jest.spyOn(service as any, 'handleAlbum');
      await (service as any).onMessageEvent({
        isChannel: true,
        chatId: bigInt(config.memeChanelId),
      });
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('пересылает одиночное сообщение с медиа боту с задержкой, если это не реклама', async () => {
      jest.useFakeTimers();
      const { service } = setup();
      jest.spyOn(service as any, 'handleAlbum').mockResolvedValue(false);
      jest.spyOn(service as any, 'isAdPost').mockResolvedValue(false);
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = {
        isChannel: true,
        chatId: bigInt(-1009999999999),
        message: { photo: [{ file_id: 'p' }], forwardTo },
      };

      await (service as any).onMessageEvent(event);
      jest.advanceTimersByTime(5000);
      await flush();

      expect(forwardTo).toHaveBeenCalledWith('@test_bot');
    });

    it('не пересылает текстовый пост без медиа', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'handleAlbum').mockResolvedValue(false);
      const isAdSpy = jest.spyOn(service as any, 'isAdPost');
      const event = { isChannel: true, chatId: bigInt(-1009999999999), message: {} };

      await (service as any).onMessageEvent(event);

      expect(isAdSpy).not.toHaveBeenCalled();
    });

    it('не пересылает одиночную рекламу', async () => {
      jest.useFakeTimers();
      const { service } = setup();
      jest.spyOn(service as any, 'handleAlbum').mockResolvedValue(false);
      jest.spyOn(service as any, 'isAdPost').mockResolvedValue(true);
      const forwardTo = jest.fn();
      const event = {
        isChannel: true,
        chatId: bigInt(-5),
        message: { photo: [{ file_id: 'p' }], forwardTo },
      };

      await (service as any).onMessageEvent(event);
      jest.runOnlyPendingTimers();
      await flush();

      expect(forwardTo).not.toHaveBeenCalled();
    });

    it('не пересылает одиночное сообщение, если его обработал альбом', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'handleAlbum').mockResolvedValue(true);
      const isAdSpy = jest.spyOn(service as any, 'isAdPost');
      const event = {
        isChannel: true,
        chatId: bigInt(-6),
        message: { photo: [{ file_id: 'p' }] },
      };

      await (service as any).onMessageEvent(event);

      expect(isAdSpy).not.toHaveBeenCalled();
    });
  });

  describe('forwardToBot', () => {
    it('форвардит пост боту и кэширует адресата', async () => {
      const { service, bot } = setup();
      const forwardTo = jest.fn().mockResolvedValue(undefined);
      const event = { message: { forwardTo } };

      await (service as any).forwardToBot(event);

      expect(bot.api.getMe).toHaveBeenCalledTimes(1);
      expect(forwardTo).toHaveBeenCalledWith('@test_bot');

      await (service as any).forwardToBot(event);
      expect(bot.api.getMe).toHaveBeenCalledTimes(1);
    });

    it('без username бота не форвардит и логирует ошибку', async () => {
      const { service, bot } = setup();
      bot.api.getMe.mockResolvedValue({ id: 777, username: undefined });
      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const forwardTo = jest.fn().mockResolvedValue(undefined);

      await expect((service as any).forwardToBot({ message: { forwardTo } })).resolves.toBeUndefined();

      expect(forwardTo).not.toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalled();
    });

    it('логирует ошибку форварда и не падает', async () => {
      const { service } = setup();
      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const event = { message: { forwardTo: jest.fn().mockRejectedValue(new Error('fail')) } };

      await expect((service as any).forwardToBot(event)).resolves.toBeUndefined();
      expect(loggerSpy).toHaveBeenCalled();
    });
  });

  describe('isAdPost', () => {
    it('возвращает false, если ссылок нет', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(false);
      await expect((service as any).isAdPost({ message: { message: 'hi' } })).resolves.toBe(false);
    });

    it('возвращает false, если текст пуст', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(true);
      await expect((service as any).isAdPost({ message: {} })).resolves.toBe(false);
    });

    it('возвращает false, если URL не извлечены', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(true);
      await expect(
        (service as any).isAdPost({ message: { message: 'hi' } })
      ).resolves.toBe(false);
    });

    it('считает рекламой ссылку на другой канал', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(true);
      (service as any).telegramClient = { getEntity: jest.fn().mockResolvedValue({ id: bigInt(2) }) };
      jest.spyOn(service as any, 'resolveUrl').mockResolvedValue({ id: bigInt(3) });
      const event = { message: { message: 'see t.me/x', entities: [urlEntity(0, 3)] } };

      await expect((service as any).isAdPost(event)).resolves.toBe(true);
    });

    it('не считает рекламой ссылку на текущий канал', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(true);
      const channel = { id: bigInt(2) };
      (service as any).telegramClient = { getEntity: jest.fn().mockResolvedValue(channel) };
      jest.spyOn(service as any, 'resolveUrl').mockResolvedValue(channel);
      const event = { message: { message: 'see t.me/x', entities: [urlEntity(0, 3)] } };

      await expect((service as any).isAdPost(event)).resolves.toBe(false);
    });

    it('считает рекламой ссылку, которую не удалось разрешить', async () => {
      const { service } = setup();
      jest.spyOn(service as any, 'isPostWithLinks').mockResolvedValue(true);
      (service as any).telegramClient = { getEntity: jest.fn().mockResolvedValue({ id: bigInt(2) }) };
      jest.spyOn(service as any, 'resolveUrl').mockRejectedValue(new Error('nope'));
      const event = { message: { message: 'see t.me/x', entities: [urlEntity(0, 3)] } };

      await expect((service as any).isAdPost(event)).resolves.toBe(true);
    });
  });

  describe('isPostWithLinks', () => {
    it('false без подписи', async () => {
      const { service } = setup();
      await expect((service as any).isPostWithLinks({ message: {} })).resolves.toBe(false);
    });

    it('true для MessageEntityUrl', async () => {
      const { service } = setup();
      await expect(
        (service as any).isPostWithLinks({ message: { message: 'x', entities: [urlEntity(0, 1)] } })
      ).resolves.toBe(true);
    });

    it('true для MessageEntityTextUrl', async () => {
      const { service } = setup();
      await expect(
        (service as any).isPostWithLinks({
          message: { message: 'x', entities: [textUrlEntity('https://t.me/y')] },
        })
      ).resolves.toBe(true);
    });

    it('false для сущностей без ссылок', async () => {
      const { service } = setup();
      await expect(
        (service as any).isPostWithLinks({ message: { message: 'x', entities: [{}] } })
      ).resolves.toBe(false);
    });

    it('false без сообщения', async () => {
      const { service } = setup();
      await expect((service as any).isPostWithLinks({})).resolves.toBe(false);
      await expect((service as any).isPostWithLinks()).resolves.toBe(false);
    });
  });

  describe('postDailyBestMeme', () => {
    // Фиксируем время, чтобы окно «последние 24 часа» и date у сообщений
    // не зависели от реальных Date.now() и не флакали на границе суток.
    const NOW = new Date('2026-09-18T18:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
    });

    function resultMessage(id: number, overrides: any = {}) {
      return {
        id,
        date: Math.floor(Date.now() / 1000),
        views: 0,
        photo: {},
        ...overrides,
      };
    }

    function recent(id: number, views: number, reactions?: number[]) {
      const msg: any = resultMessage(id, { views });
      if (reactions) {
        msg.reactions = { results: reactions.map((count) => ({ count })) };
      }
      return msg;
    }

    it('логирует и выходит, если сообщений нет', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([]),
      };

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).not.toHaveBeenCalled();
    });

    it('логирует и выходит, если в последние сутки сообщений нет', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([{ id: 1, date: 1, views: 100, photo: {} }]),
      };

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).not.toHaveBeenCalled();
    });

    it('включает сообщение ровно на границе 24 часов и отсекает более старое', async () => {
      const { service, bot } = setup();
      const boundary = Math.floor(Date.now() / 1000) - 86400;
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([
          { id: 61, date: boundary, views: 10, photo: {} },
          { id: 62, date: boundary - 1, views: 999, photo: {} },
        ]),
      };
      bot.api.copyMessage.mockResolvedValue({ message_id: 111 });

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).toHaveBeenCalledTimes(1);
      expect(bot.api.copyMessage).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        61,
        { disable_notification: true }
      );
    });

    it('логирует и выходит без подходящих сообщений', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([recent(1, 0)]),
      };

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).not.toHaveBeenCalled();
    });

    it('постит один лучший пост, если просмотры и реакции у одного сообщения', async () => {
      const { service, bot, config } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([recent(11, 50, [3, 4]), recent(12, 5)]),
      };
      bot.api.copyMessage.mockResolvedValue({ message_id: 500 });

      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).toHaveBeenCalledWith(
        config.bestMemeChanelId,
        config.memeChanelId,
        11,
        { disable_notification: false }
      );
      expect(received).toEqual([
        { byViewPostMemeId: 11, byLikePostMemeId: 11, byViewPostBestMemeId: 500 },
      ]);
    });

    it('постит лучший по просмотрам и лучший по реакциям как разные посты', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([recent(21, 90), recent(22, 10, [9])]),
      };
      bot.api.copyMessage.mockResolvedValue({ message_id: 600 });

      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).toHaveBeenNthCalledWith(
        1,
        expect.any(Number),
        expect.any(Number),
        21,
        { disable_notification: true }
      );
      expect(bot.api.copyMessage).toHaveBeenNthCalledWith(
        2,
        expect.any(Number),
        expect.any(Number),
        22,
        { disable_notification: false }
      );
      expect(received).toEqual([
        { byViewPostMemeId: 21, byLikePostMemeId: 22, byLikePostBestMemeId: 600 },
      ]);
    });

    it('постит только лучший пост по реакциям, когда просмотров нет', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([recent(31, 0, [7])]),
      };
      bot.api.copyMessage.mockResolvedValue({ message_id: 700 });

      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).toHaveBeenCalledTimes(1);
      expect(received).toEqual([{ byLikePostMemeId: 31, byLikePostBestMemeId: 700 }]);
    });

    it('не эмитит событие при явном alternateChatId', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([recent(41, 5)]),
      };
      bot.api.copyMessage.mockResolvedValue({ message_id: 800 });

      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await service.postDailyBestMeme(999);

      expect(bot.api.copyMessage).toHaveBeenCalledWith(999, expect.any(Number), 41, {
        disable_notification: true,
      });
      expect(received).toEqual([]);
    });

    it('обрабатывает сообщения без реакций и с несколькими результатами', async () => {
      const { service, bot } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockResolvedValue('channel'),
        getMessages: jest.fn().mockResolvedValue([
          { id: 51, date: Math.floor(Date.now() / 1000), views: 3, video: {} },
          {
            id: 52,
            date: Math.floor(Date.now() / 1000),
            views: 1,
            reactions: { results: [{ count: 2 }, { count: 5 }] },
            photo: {},
          },
        ]),
      };
      bot.api.copyMessage.mockResolvedValue({ message_id: 900 });

      await service.postDailyBestMeme();

      expect(bot.api.copyMessage).toHaveBeenCalledTimes(2);
    });

    it('в случае ошибки шлёт запасное событие и пробрасывает ошибку', async () => {
      const { service } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn().mockRejectedValue(new Error('boom')),
        getMessages: jest.fn(),
      };

      const received: any[] = [];
      service.bestMemesDaily$.subscribe((value) => received.push(value));

      await expect(service.postDailyBestMeme()).rejects.toThrow('boom');
      expect(received).toEqual([{ byLikePostMemeId: 37, byViewPostMemeId: 37 }]);
    });
  });

  describe('copyMessage', () => {
    it('возвращает id скопированного сообщения', async () => {
      const { service, bot, config } = setup();
      bot.api.copyMessage.mockResolvedValue({ message_id: 321 });

      await expect((service as any).copyMessage(7, true)).resolves.toBe(321);
      expect(bot.api.copyMessage).toHaveBeenCalledWith(
        config.bestMemeChanelId,
        config.memeChanelId,
        7,
        { disable_notification: true }
      );
    });

    it('использует alternateChatId, если он задан', async () => {
      const { service, bot } = setup();
      bot.api.copyMessage.mockResolvedValue({ message_id: 1 });

      await (service as any).copyMessage(7, false, 555);

      expect(bot.api.copyMessage.mock.calls[0][0]).toBe(555);
    });

    it('возвращает undefined и не падает при ошибке копирования', async () => {
      const { service, bot } = setup();
      bot.api.copyMessage.mockRejectedValue(new Error('copy failed'));

      await expect((service as any).copyMessage(7, false)).resolves.toBeUndefined();
    });
  });

  describe('extractUrls', () => {
    it('возвращает пустой массив без entities', async () => {
      const { service } = setup();
      await expect((service as any).extractUrls({ message: {} })).resolves.toEqual([]);
    });

    it('извлекает URL из MessageEntityUrl по offset/length', async () => {
      const { service } = setup();
      const message = { message: 'go to https://site.ru now', entities: [urlEntity(6, 15)] };
      await expect((service as any).extractUrls({ message })).resolves.toEqual([
        'https://site.ru',
      ]);
    });

    it('извлекает URL из MessageEntityTextUrl', async () => {
      const { service } = setup();
      const message = { message: 'click', entities: [textUrlEntity('https://t.me/hidden')] };
      await expect((service as any).extractUrls({ message })).resolves.toEqual([
        'https://t.me/hidden',
      ]);
    });
  });

  describe('hasMediaContent', () => {
    it('true для photo и video', () => {
      const { service } = setup();
      expect((service as any).hasMediaContent({ photo: {} })).toBe(true);
      expect((service as any).hasMediaContent({ video: {} })).toBe(true);
    });

    it('true для media-photo', () => {
      const { service } = setup();
      expect(
        (service as any).hasMediaContent({
          media: new Api.MessageMediaPhoto({ photo: undefined as any }),
        })
      ).toBe(true);
    });

    it('true для video-документа и false для прочих', () => {
      const { service } = setup();
      expect((service as any).hasMediaContent({ media: mediaDocument('video/mp4') })).toBe(true);
      expect((service as any).hasMediaContent({ media: mediaDocument('image/png') })).toBe(false);
    });

    it('false без медиа', () => {
      const { service } = setup();
      expect((service as any).hasMediaContent({})).toBe(false);
    });
  });

  describe('resolveUrl', () => {
    it('раскрывает сокращённую ссылку t.me и достаёт entity', async () => {
      const { service } = setup();
      const getEntity = jest.fn().mockResolvedValue('entity');
      (service as any).telegramClient = { getEntity };

      await expect((service as any).resolveUrl('t.me/somechannel')).resolves.toBe('entity');
      expect(getEntity).toHaveBeenCalledWith('somechannel');
    });

    it('достаёт username из полной t.me ссылки', async () => {
      const { service } = setup();
      const getEntity = jest.fn().mockResolvedValue('entity');
      (service as any).telegramClient = { getEntity };

      await (service as any).resolveUrl('https://t.me/channel/123');

      expect(getEntity).toHaveBeenCalledWith('channel');
    });

    it('помечает внешние ссылки', async () => {
      const { service } = setup();
      await expect((service as any).resolveUrl('https://example.com/x')).resolves.toEqual({
        isExternal: true,
        url: 'https://example.com/x',
      });
    });

    it('резолвит invite-ссылку через invoke CheckChatInvite', async () => {
      const { service } = setup();
      const invoke = jest.fn().mockResolvedValue({ chat: { id: bigInt(9) } });
      (service as any).telegramClient = { getEntity: jest.fn(), invoke };

      await expect((service as any).resolveUrl('https://t.me/+hash')).resolves.toEqual({
        id: bigInt(9),
      });
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('возвращает undefined из checkInvite при ошибке', async () => {
      const { service } = setup();
      (service as any).telegramClient = {
        getEntity: jest.fn(),
        invoke: jest.fn().mockRejectedValue(new Error('x')),
      };

      await expect((service as any).checkInvite('h')).resolves.toBeUndefined();
    });
  });

  describe('isSameChannel', () => {
    it('false для внешней ссылки', () => {
      const { service } = setup();
      expect((service as any).isSameChannel({ isExternal: true }, { id: bigInt(1) })).toBe(false);
    });

    it('сравнивает id каналов', () => {
      const { service } = setup();
      expect(
        (service as any).isSameChannel({ id: bigInt(1) }, { id: bigInt(1) })
      ).toBe(true);
      expect(
        (service as any).isSameChannel({ id: bigInt(1) }, { id: bigInt(2) })
      ).toBe(false);
    });

    it('сравнивает username без учёта регистра', () => {
      const { service } = setup();
      expect(
        (service as any).isSameChannel({ username: 'AbC' }, { username: 'abc' })
      ).toBe(true);
      expect(
        (service as any).isSameChannel({ username: 'abc' }, { username: 'xyz' })
      ).toBe(false);
    });

    it('false без id и username', () => {
      const { service } = setup();
      expect((service as any).isSameChannel({}, {})).toBe(false);
    });
  });
});
