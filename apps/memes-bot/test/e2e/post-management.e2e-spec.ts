import { of } from 'rxjs';
import { Repository } from 'typeorm';
import { E2EHarness, createE2EHarness, findCall, privateMessageUpdate, waitFor } from './harness';
import { PublishedPostHashesEntity } from '../../src/app/modules/bot/entities/published-post-hashes.entity';
import { UserRequestEntity } from '../../src/app/modules/bot/entities/user-request.entity';
import { UserEntity } from '../../src/app/modules/bot/entities/user.entity';
import { SessionEntity } from '../../src/app/modules/bot/session/session.entity';
import { DeduplicationService } from '../../src/app/modules/bot/services/deduplication.service';
import { ClientBaseService } from '../../src/app/modules/client/services/client-base.service';
import { ObservatoryPostEntity } from '../../src/app/modules/observatory/entities/observatory-post.entity';
import { UserModeratedPostEntity } from '../../src/app/modules/observatory/entities/user-moderated-post.entity';
import { UserModeratedPostService } from '../../src/app/modules/observatory/services/user-moderated-post.service';
import { PublicationModesEnum } from '../../src/app/modules/post-management/constants/publication-modes.enum';
import { UserPostManagementService } from '../../src/app/modules/post-management/user-post-management.service';
import { TrollSettingsService } from '../../src/app/modules/troll/services/troll-settings.service';

/**
 * imghash детерминирован в тестах: дедупликация должна сравнивать хеши реальным
 * SIMILARITY из Postgres, поэтому мокается только сама функция вычисления хеша.
 */
const mockHash = 'hash';
jest.mock('imghash', () => ({
  __esModule: true,
  hash: jest.fn(async () => mockHash),
}));

const OWNER_ID = Number(process.env.BOT_OWNER_ID);
const REQUEST_CHANNEL = -1003333333333;
const MEME_CHANNEL = -1001111111111;
const OBSERVER_CHANNEL = -1005555555555;

const USER_ID = 515151;
const MOD_ID = 777;

const PHOTO = [
  { file_id: 'small', file_unique_id: 'photo-small', width: 90, height: 90 },
  { file_id: 'big', file_unique_id: 'photo-big', width: 640, height: 480 },
];

/** Собирает update сообщения с фото в личке. */
function privatePhotoUpdate(options: {
  updateId?: number;
  messageId?: number;
  userId?: number;
  fileUniqueId?: string;
  caption?: string;
}): Record<string, any> {
  const userId = options.userId ?? USER_ID;
  return {
    update_id: options.updateId ?? 101,
    message: {
      message_id: options.messageId ?? 30,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'User', username: 'user' },
      photo: PHOTO.map((p, index) => ({
        ...p,
        file_unique_id: index === PHOTO.length - 1 ? options.fileUniqueId ?? p.file_unique_id : p.file_unique_id,
      })),
      caption: options.caption,
    },
  };
}

/** Собирает update нажатия inline-кнопки. */
function callbackUpdate(options: {
  fromId: number;
  chatId: number;
  messageId: number;
  data: string;
  chatType?: 'private' | 'channel' | 'supergroup';
  username?: string;
}): Record<string, any> {
  return {
    update_id: 9001,
    callback_query: {
      id: `cb-${options.fromId}-${options.messageId}-${options.data.slice(0, 8)}`,
      from: {
        id: options.fromId,
        is_bot: false,
        first_name: 'User',
        username: options.username ?? 'user',
      },
      message: {
        message_id: options.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: options.chatId, type: options.chatType ?? 'private' },
        text: 'post',
      },
      chat_instance: 'chat-instance',
      data: options.data,
    },
  };
}

/** Достаёт реальный callback_data кнопки отрендеренного меню. */
async function buttonData(
  menu: any,
  predicate: (text: string) => boolean
): Promise<string> {
  const rows = await menu.render({});
  for (const row of rows) {
    for (const button of row) {
      if (button.callback_data && predicate(String(button.text))) {
        return button.callback_data;
      }
    }
  }
  throw new Error('menu button not found');
}

describe('E2E: post-management, menus и observatory', () => {
  let h: E2EHarness;
  let userRepo: Repository<UserEntity>;
  let requestRepo: Repository<UserRequestEntity>;
  let sessionRepo: Repository<SessionEntity>;
  let publishedHashRepo: Repository<PublishedPostHashesEntity>;
  let observatoryRepo: Repository<ObservatoryPostEntity>;
  let userModeratedRepo: Repository<UserModeratedPostEntity>;

  beforeEach(async () => {
    h = await createE2EHarness();
    await h.resetDb();

    // Реальный HTTP не нужен: содержимое картинки подменяем, чтобы DeduplicationService
    // дошёл до imghash, а не упал на скачивании файла. Спай на прототипе покрывает
    // все инстансы HttpService (модули создают свои). require ленивый: axios в этом
    // репозитории ESM и мокается харнесом до первого реального импорта.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpService } = require('@nestjs/axios');
    jest
      .spyOn(HttpService.prototype, 'get')
      .mockReturnValue(of({ data: Buffer.from('fake-image') }) as any);

    userRepo = h.dataSource.getRepository(UserEntity);
    requestRepo = h.dataSource.getRepository(UserRequestEntity);
    sessionRepo = h.dataSource.getRepository(SessionEntity);
    publishedHashRepo = h.dataSource.getRepository(PublishedPostHashesEntity);
    observatoryRepo = h.dataSource.getRepository(ObservatoryPostEntity);
    userModeratedRepo = h.dataSource.getRepository(UserModeratedPostEntity);

    // Пользователь и модератор, которыми подписываем апдейты и заявки.
    await userRepo.save({ id: USER_ID, username: 'user', firstName: 'User' });
    await userRepo.save({
      id: MOD_ID,
      username: 'mod',
      firstName: 'Mod',
      isModerator: true,
      allowPublishToChannel: true,
      allowDeleteRejectedPost: true,
      allowRestoreDiscardedPost: true,
      allowSetStrike: true,
      allowMakeBan: true,
      canBeModeratePosts: false,
    });

    // Капча для приватных сообщений проходится сессией в БД (ключ = id чата).
    await sessionRepo.save({
      key: String(USER_ID),
      value: JSON.stringify({ anonymousPublishing: false, canBeModeratePosts: true, captchaSolved: true }),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.close();
  });

  describe('обращения к админу (текст)', () => {
    it('пересылает текст в канал обращений, пинит и сохраняет заявку', async () => {
      await h.sendUpdate(
        privateMessageUpdate({ userId: USER_ID, messageId: 40, text: 'Привет, есть вопрос' })
      );

      const header = findCall(
        h.calls,
        'sendMessage',
        (p) => p.chat_id === REQUEST_CHANNEL && String(p.text).includes('Обращение от')
      );
      expect(header).toBeDefined();
      expect(String(header!.payload.text)).toContain('@user');

      expect(
        findCall(
          h.calls,
          'copyMessage',
          (p) => p.chat_id === REQUEST_CHANNEL && p.from_chat_id === USER_ID && p.message_id === 40
        )
      ).toBeDefined();
      expect(
        findCall(h.calls, 'pinChatMessage', (p) => p.chat_id === REQUEST_CHANNEL)
      ).toBeDefined();

      const saved = await requestRepo.findOne({ where: { originalMessageId: 40 } });
      expect(saved).toBeDefined();
      expect(saved!.isTextRequest).toBe(true);
    });
  });

  describe('предложка мемов (фото)', () => {
    it('отправляет фото в предложку и сохраняет заявку с fileUniqueId', async () => {
      await h.sendUpdate(
        privatePhotoUpdate({ userId: USER_ID, messageId: 50, fileUniqueId: 'unique-post-1' })
      );

      expect(
        findCall(
          h.calls,
          'copyMessage',
          (p) => p.chat_id === REQUEST_CHANNEL && p.from_chat_id === USER_ID && p.message_id === 50
        )
      ).toBeDefined();
      expect(
        findCall(
          h.calls,
          'sendMessage',
          (p) => p.chat_id === REQUEST_CHANNEL && String(p.text).includes('Пост от')
        )
      ).toBeDefined();

      const saved = await requestRepo.findOne({ where: { fileUniqueId: 'unique-post-1' } });
      expect(saved).toBeDefined();
      expect(saved!.isTextRequest).toBe(false);
    });

    it('отказывает при превышении лимита 5 постов в сутки', async () => {
      for (let i = 0; i < 5; i++) {
        await requestRepo.insert({
          user: { id: USER_ID },
          isAnonymousPublishing: false,
          originalMessageId: 600 + i,
          userRequestChannelMessageId: 610 + i,
          isTextRequest: false,
          createdAt: new Date(),
        });
      }

      await h.sendUpdate(privatePhotoUpdate({ userId: USER_ID, messageId: 55, updateId: 105 }));

      const refusal = findCall(
        h.calls,
        'sendMessage',
        (p) => p.chat_id === USER_ID && String(p.text).includes('максимум 5 постов')
      );
      expect(refusal).toBeDefined();
      // Заявка всё равно сохраняется и копируется в канал (для снятия лимита модератором).
      expect(
        findCall(h.calls, 'copyMessage', (p) => p.chat_id === REQUEST_CHANNEL && p.message_id === 55)
      ).toBeDefined();
    });

    it('помечает опубликованный дубликат и репостит оригинал', async () => {
      const dedup = h.moduleRef.get(DeduplicationService, { strict: false });
      const hash = await dedup.getPostImageHash(PHOTO as any);
      expect(hash).toBeTruthy();
      await publishedHashRepo.insert({
        hash,
        memeChannelMessageId: 9001,
        createdAt: new Date(),
      });
      h.clearCalls();

      await h.sendUpdate(
        privatePhotoUpdate({ userId: USER_ID, messageId: 60, updateId: 106, fileUniqueId: 'dup-1' })
      );

      const saved = await requestRepo.findOne({ where: { fileUniqueId: 'dup-1' } });
      expect(saved).toBeDefined();
      expect(saved!.possibleDuplicate).toBe(true);

      // Оригинал переслан из канала мемов в канал обращений для сравнения.
      expect(
        findCall(
          h.calls,
          'forwardMessage',
          (p) =>
            p.chat_id === REQUEST_CHANNEL &&
            p.from_chat_id === MEME_CHANNEL &&
            String(p.message_id) === '9001'
        )
      ).toBeDefined();
    });
  });

  describe('модерация заявок', () => {
    async function seedRequest(messageId: number): Promise<void> {
      await requestRepo.insert({
        user: { id: USER_ID },
        isAnonymousPublishing: false,
        originalMessageId: 700 + messageId,
        userRequestChannelMessageId: messageId,
        isTextRequest: false,
      });
    }

    it('approve меняет статус заявки и автора модерации', async () => {
      await seedRequest(300);
      const postService = h.moduleRef.get(UserPostManagementService, { strict: false });
      const data = await buttonData((postService as any).moderatedPostMenu, (t) => t.includes('Одобрить'));

      await h.sendUpdate(
        callbackUpdate({ fromId: MOD_ID, chatId: REQUEST_CHANNEL, messageId: 300, data, chatType: 'channel' })
      );

      const saved = await requestRepo.findOne({
        where: { userRequestChannelMessageId: 300 },
        relations: { processedByModerator: true },
      });
      expect(saved!.isApproved).toBe(true);
      expect(String(saved!.processedByModerator?.id)).toBe(String(MOD_ID));
      expect(saved!.moderatedAt).toBeTruthy();
    });

    it('reject меняет статус и уведомляет пользователя', async () => {
      await seedRequest(301);
      const postService = h.moduleRef.get(UserPostManagementService, { strict: false });
      const data = await buttonData((postService as any).moderatedPostMenu, (t) => t.includes('Отклонить'));

      await h.sendUpdate(
        callbackUpdate({ fromId: MOD_ID, chatId: REQUEST_CHANNEL, messageId: 301, data, chatType: 'channel' })
      );

      const saved = await requestRepo.findOne({
        where: { userRequestChannelMessageId: 301 },
        relations: { processedByModerator: true },
      });
      expect(saved!.isApproved).toBe(false);
      expect(String(saved!.processedByModerator?.id)).toBe(String(MOD_ID));

      const notice = findCall(
        h.calls,
        'sendMessage',
        (p) => Number(p.chat_id) === USER_ID && String(p.text).includes('не можем такое опубликовать')
      );
      expect(notice).toBeDefined();
    });
  });

  describe('меню', () => {
    it('/menu у владельца показывает админскую клавиатуру', async () => {
      await h.sendUpdate(privateMessageUpdate({ userId: OWNER_ID, messageId: 70, text: '/menu' }));

      const reply = findCall(h.calls, 'sendMessage', (p) => p.chat_id === OWNER_ID && !!p.reply_markup);
      expect(reply).toBeDefined();
      expect(String(reply!.payload.text)).toContain('Выбери то, что хочешь сделать');

      const flat = (reply!.payload.reply_markup.inline_keyboard as any[][])
        .flat()
        .map((b) => String(b.text));
      expect(flat).toContain('🤖 Тролль-бот');
    });
  });

  describe('observatory', () => {
    it('observerChannelPost$ копирует пост обсерватории в канал обращений', async () => {
      const client = h.moduleRef.get(ClientBaseService, { strict: false }) as any;
      const copyMessage = jest.fn().mockResolvedValue({ message_id: 700 });
      const ctx = {
        channelPost: { message_id: 555, sender_chat: { id: OBSERVER_CHANNEL }, photo: PHOTO },
        api: { copyMessage },
      };

      client.observerChannelPost$.next(ctx);

      await waitFor(async () => {
        expect(
          await observatoryRepo.findOne({ where: { requestChannelMessageId: 700 } })
        ).not.toBeNull();
      });

      expect(copyMessage).toHaveBeenCalledWith(
        REQUEST_CHANNEL,
        OBSERVER_CHANNEL,
        555,
        expect.objectContaining({ disable_notification: true })
      );
    });

    it('user-moderation round: голос пользователя и публикация по итогу', async () => {
      const userModerated = h.moduleRef.get(UserModeratedPostService, { strict: false });
      // Репост в чаты — fire-and-forget с рандомом; выключаем, чтобы публикация
      // гарантированно завершалась до закрытия харнеса.
      const trollSettings = h.moduleRef.get(TrollSettingsService, { strict: false });
      await trollSettings.update({ memeAnnounceEnabled: false });
      const copyToUser = jest.fn().mockResolvedValue({ message_id: 880 });
      const usersCtx = { api: { copyMessage: copyToUser } } as any;

      const count = await userModerated.moderateViaUsers(usersCtx, {
        mode: PublicationModesEnum.NOW_SILENT,
        requestChannelMessageId: 400,
        processedByModerator: MOD_ID,
        isUserPost: false,
        hash: 'hash',
      });
      expect(count).toBe(1);
      // Не сравниваем объект меню (у него прокси-геттер), проверяем позиционные аргументы.
      expect(copyToUser).toHaveBeenCalledTimes(1);
      const copiedCall = copyToUser.mock.calls[0];
      expect(copiedCall.slice(0, 3).map(Number)).toEqual([USER_ID, REQUEST_CHANNEL, 400]);
      expect(copiedCall[3]?.reply_markup).toBeDefined();

      // Пользователь голосует «за» через реальное меню.
      const voteData = await buttonData((userModerated as any).moderatePostMenu, (t) => t === '👍');
      await h.sendUpdate(
        callbackUpdate({ fromId: USER_ID, chatId: USER_ID, messageId: 880, data: voteData })
      );

      const moderated = await userModeratedRepo.findOne({ where: { requestChannelMessageId: 400 } });
      expect(Number(moderated!.likes)).toBe(1);

      // Делаем раунд «созревшим» и запускаем обработку — пост уходит в канал.
      await userModeratedRepo.update(
        { requestChannelMessageId: 400 },
        { moderatedTo: new Date(Date.now() - 1000) }
      );
      await userModerated.handleCron();

      await waitFor(() => {
        expect(
          findCall(
            h.calls,
            'copyMessage',
            (p) =>
              Number(p.chat_id) === MEME_CHANNEL &&
              Number(p.from_chat_id) === REQUEST_CHANNEL &&
              Number(p.message_id) === 400
          )
        ).toBeDefined();
      });
      // Публикация асинхронна (подписка на Subject): дожидаемся её последнего
      // шага с БД, иначе close() оборвёт запрос и ошибка всплывёт в следующем сьюте.
      await waitFor(async () => {
        const hashRow = await h.dataSource
          .getRepository(PublishedPostHashesEntity)
          .findOne({ where: { hash: 'hash' } });
        expect(hashRow).not.toBeNull();
      });

      const approved = await userModeratedRepo.findOne({ where: { requestChannelMessageId: 400 } });
      expect(approved!.isApproved).toBe(true);
    });
  });
});
