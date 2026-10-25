/**
 * E2E-покрытие крона и итогов года: плановая публикация, месячная статистика,
 * генерация/публикация итогов года. Обработчики крона вызываются напрямую,
 * БД — настоящая (Postgres), исходящие вызовы Telegram перехвачены харнесом.
 */
import { E2EHarness, createE2EHarness, findCall, waitFor } from './harness';
import { CronService } from '../../src/app/modules/cron/service/cron.service';
import { ObservatoryService } from '../../src/app/modules/observatory/services/observatory.service';
import {
  PostSchedulerService,
} from '../../src/app/modules/bot/services/post-scheduler.service';
import { PublishedPostHashesEntity } from '../../src/app/modules/bot/entities/published-post-hashes.entity';
import { GrammyError } from 'grammy';
import { YearResultsService } from '../../src/app/modules/year-results/services/year-results.service';
import { PublicationModesEnum } from '../../src/app/modules/post-management/constants/publication-modes.enum';
import { UserEntity } from '../../src/app/modules/bot/entities/user.entity';
import { UserRequestEntity } from '../../src/app/modules/bot/entities/user-request.entity';
import { PostSchedulerEntity } from '../../src/app/modules/bot/entities/post-scheduler.entity';
import { ObservatoryPostEntity } from '../../src/app/modules/observatory/entities/observatory-post.entity';
import { YearResultEntity } from '../../src/app/modules/year-results/entities/year-result.entity';

const OWNER_ID = Number(process.env.BOT_OWNER_ID);
const MEME_CHANNEL = -1001111111111;
const USER_REQUEST_CHANNEL = -1003333333333;

describe('E2E: крон и итоги года', () => {
  let h: E2EHarness;

  beforeEach(async () => {
    h = await createE2EHarness();
    await h.resetDb();
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (h) {
      await h.close();
    }
  });

  async function seedUser(
    id: number,
    overrides: Record<string, unknown> = {}
  ): Promise<UserEntity> {
    return h.dataSource.getRepository(UserEntity).save({
      id,
      username: 'vasya',
      firstName: 'Вася',
      lastName: 'Пупкин',
      isBot: false,
      lastActivity: new Date(),
      strikes: 0,
      isBanned: false,
      ...overrides,
    } as any);
  }

  /**
   * Контекст нажатия кнопки публикации без похода в Bot API: владелец, карточка
   * и ответ на колбэк. Нужен, чтобы дёргать `publishPost` конкурентно.
   */
  function makeButtonCtx(cardMessageId: number, moderatorId: number): any {
    return {
      config: { isOwner: true },
      callbackQuery: {
        message: { message_id: cardMessageId, chat: { id: USER_REQUEST_CHANNEL } },
        from: { id: moderatorId },
      },
      api: { banChatMember: jest.fn() },
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    };
  }

  describe('плановая публикация по крону', () => {
    it('публикует пост обсерватории и помечает его опубликованным', async () => {
      const user = await seedUser(77, { username: 'moder' });
      const obsRepo = h.dataSource.getRepository(ObservatoryPostEntity);
      await obsRepo.save({
        requestChannelMessageId: 500,
        isApproved: null,
        processedByModerator: user,
      });

      const postRepo = h.dataSource.getRepository(PostSchedulerEntity);
      const post = await postRepo.save({
        requestChannelMessageId: 500,
        processedByModerator: user,
        publishDate: new Date(Date.now() - 60_000),
        mode: PublicationModesEnum.NEXT_INTERVAL,
        caption: 'подпись',
        isUserPost: false,
        isPublished: false,
        hash: 'hash-1',
      } as any);

      h.clearCalls();
      const cron = h.moduleRef.get(CronService);
      await cron.handleNextScheduledPost();

      await waitFor(() =>
        expect(
          findCall(
            h.calls,
            'copyMessage',
            (p) => p.chat_id === MEME_CHANNEL && p.from_chat_id === USER_REQUEST_CHANNEL
          )
        ).toBeDefined()
      );

      const savedPost = await postRepo.findOne({ where: { id: post.id } });
      expect(savedPost?.isPublished).toBe(true);

      const savedObs = await obsRepo.findOne({ where: { requestChannelMessageId: 500 } });
      expect(savedObs?.isApproved).toBe(true);
      expect(savedObs?.publishedMessageId).toBeDefined();
    });

    it('(TGB-117) claim атомарен: второй вызов по тому же посту возвращает false', async () => {
      const user = await seedUser(78, { username: 'moder2' });
      const postRepo = h.dataSource.getRepository(PostSchedulerEntity);
      const post = await postRepo.save({
        requestChannelMessageId: 501,
        processedByModerator: user,
        publishDate: new Date(Date.now() - 60_000),
        mode: PublicationModesEnum.NEXT_INTERVAL,
        isUserPost: false,
        isPublished: false,
        hash: 'hash-claim',
      } as any);

      const scheduler = h.moduleRef.get(PostSchedulerService);
      await expect(scheduler.claimPostForPublish(post.id)).resolves.toBe(true);
      await expect(scheduler.claimPostForPublish(post.id)).resolves.toBe(false);

      const saved = await postRepo.findOne({ where: { id: post.id } });
      expect(saved?.isPublished).toBe(true);
      await expect(scheduler.isRequestMessagePublished(501)).resolves.toBe(true);
    });

    it('(TGB-117) два одновременных тика крона отправляют карточку один раз', async () => {
      const user = await seedUser(79, { username: 'moder3' });
      await h.dataSource.getRepository(ObservatoryPostEntity).save({
        requestChannelMessageId: 502,
        isApproved: null,
        processedByModerator: user,
      });
      const postRepo = h.dataSource.getRepository(PostSchedulerEntity);
      await postRepo.save({
        requestChannelMessageId: 502,
        processedByModerator: user,
        publishDate: new Date(Date.now() - 60_000),
        mode: PublicationModesEnum.NEXT_INTERVAL,
        isUserPost: false,
        isPublished: false,
        hash: 'hash-double-tick',
      } as any);

      h.clearCalls();
      const cron = h.moduleRef.get(CronService);
      // Гонка из инцидента: оба тика читают одну и ту же непомеченную строку.
      await Promise.all([cron.handleNextScheduledPost(), cron.handleNextScheduledPost()]);

      const copies = h.calls.filter(
        (call) =>
          call.method === 'copyMessage' &&
          call.payload.chat_id === MEME_CHANNEL &&
          call.payload.from_chat_id === USER_REQUEST_CHANNEL
      );
      expect(copies).toHaveLength(1);

      const hashes = await h.dataSource
        .getRepository(PublishedPostHashesEntity)
        .find({ where: { hash: 'hash-double-tick' } });
      expect(hashes).toHaveLength(1);
    });

    it('(TGB-117) ручная публикация съедает ожидающую запись сетки — cron не дублирует', async () => {
      const user = await seedUser(81, { username: 'moder5' });
      await h.dataSource.getRepository(ObservatoryPostEntity).save({
        requestChannelMessageId: 504,
        isApproved: true,
        processedByModerator: user,
      });
      const postRepo = h.dataSource.getRepository(PostSchedulerEntity);
      const post = await postRepo.save({
        requestChannelMessageId: 504,
        processedByModerator: user,
        publishDate: new Date(Date.now() - 60_000),
        mode: PublicationModesEnum.NEXT_MORNING,
        isUserPost: false,
        isPublished: false,
        hash: 'hash-button',
      } as any);

      h.clearCalls();
      const observatory = h.moduleRef.get(ObservatoryService);
      await (observatory as any).publishPost(makeButtonCtx(504, user.id), PublicationModesEnum.NOW_SILENT);

      // Ожидающая запись забрана кнопкой и больше не ждёт cron.
      const claimed = await postRepo.findOne({ where: { id: post.id } });
      expect(claimed?.isPublished).toBe(true);

      const cron = h.moduleRef.get(CronService);
      await cron.handleNextScheduledPost();

      const copies = h.calls.filter(
        (call) =>
          call.method === 'copyMessage' &&
          call.payload.chat_id === MEME_CHANNEL &&
          call.payload.from_chat_id === USER_REQUEST_CHANNEL
      );
      expect(copies).toHaveLength(1);
    });

    it('(TGB-117) ручная публикация без записи в сетке вставляет claim-строку', async () => {
      const user = await seedUser(82, { username: 'moder6' });
      await h.dataSource.getRepository(ObservatoryPostEntity).save({
        requestChannelMessageId: 505,
        isApproved: true,
        processedByModerator: user,
      });
      const postRepo = h.dataSource.getRepository(PostSchedulerEntity);

      h.clearCalls();
      const observatory = h.moduleRef.get(ObservatoryService);
      await (observatory as any).publishPost(makeButtonCtx(505, user.id), PublicationModesEnum.NOW_SILENT);

      const claims = await postRepo.find({ where: { requestChannelMessageId: 505 } });
      expect(claims).toHaveLength(1);
      expect(claims[0].isPublished).toBe(true);
      expect(claims[0].mode).toBe(PublicationModesEnum.NOW_SILENT);
      expect(
        h.calls.filter(
          (call) =>
            call.method === 'copyMessage' && call.payload.chat_id === MEME_CHANNEL
        )
      ).toHaveLength(1);
    });

    it('(TGB-117) два одновременных ручных клика по карточке без записи дают одну копию', async () => {
      const user = await seedUser(83, { username: 'moder7' });
      await h.dataSource.getRepository(ObservatoryPostEntity).save({
        requestChannelMessageId: 506,
        isApproved: true,
        processedByModerator: user,
      });

      h.clearCalls();
      const observatory = h.moduleRef.get(ObservatoryService);
      await Promise.all([
        (observatory as any).publishPost(makeButtonCtx(506, user.id), PublicationModesEnum.NOW_SILENT),
        (observatory as any).publishPost(makeButtonCtx(506, user.id), PublicationModesEnum.NOW_SILENT),
      ]);

      expect(
        h.calls.filter(
          (call) =>
            call.method === 'copyMessage' &&
            call.payload.chat_id === MEME_CHANNEL &&
            call.payload.from_chat_id === USER_REQUEST_CHANNEL
        )
      ).toHaveLength(1);

      // Ровно одна claim-строка на карточку: второй клик её не задвоил.
      const claims = await h.dataSource
        .getRepository(PostSchedulerEntity)
        .find({ where: { requestChannelMessageId: 506 } });
      expect(claims).toHaveLength(1);
    });

    it('(TGB-117) «message is not modified» на правке клавиатуры не теряет хеш публикации', async () => {
      const user = await seedUser(80, { username: 'moder4' });
      await h.dataSource.getRepository(ObservatoryPostEntity).save({
        requestChannelMessageId: 503,
        isApproved: null,
        processedByModerator: user,
      });
      // Telegram отвечает 400, когда клавиатура уже целевая — пост при этом уже в канале.
      jest.spyOn(h.bot.api, 'editMessageReplyMarkup').mockRejectedValue(
        new GrammyError(
          "Call to 'editMessageReplyMarkup' failed!",
          { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
          'editMessageReplyMarkup',
          {}
        )
      );

      const observatory = h.moduleRef.get(ObservatoryService);
      await expect(
        observatory.onPublishNow({
          mode: PublicationModesEnum.NEXT_INTERVAL,
          requestChannelMessageId: 503,
          processedByModerator: user.id,
          isUserPost: false,
          hash: 'hash-noop-edit',
          source: 'cron',
        })
      ).resolves.toBeGreaterThan(0);

      const hashes = await h.dataSource
        .getRepository(PublishedPostHashesEntity)
        .find({ where: { hash: 'hash-noop-edit' } });
      expect(hashes).toHaveLength(1);
    });
  });

  describe('месячная статистика по крону', () => {
    it('публикует топ предложки и рассылает личную статистику', async () => {
      const user = await seedUser(102, { username: 'petya', firstName: 'Пётр', lastName: null });
      await h.dataSource.getRepository(UserRequestEntity).save({
        user,
        isAnonymousPublishing: false,
        originalMessageId: 2,
        isPublished: true,
        publishedAt: new Date(),
      } as any);

      h.clearCalls();
      const cron = h.moduleRef.get(CronService);
      await cron.onCronTime();

      await waitFor(() => {
        const message = findCall(
          h.calls,
          'sendMessage',
          (p) => p.chat_id === MEME_CHANNEL && String(p.text).includes('#статистика')
        );
        expect(message).toBeDefined();
        expect(String(message!.payload.text)).toContain('@petya');
      });

      await waitFor(() =>
        expect(
          findCall(h.calls, 'forwardMessage', (p) => Number(p.chat_id) === 102)
        ).toBeDefined()
      );
    });
  });

  describe('итоги года', () => {
    async function seedYearData(year: number): Promise<void> {
      const user = await seedUser(101, { username: 'vasya', firstName: 'Вася' });
      const requests = h.dataSource.getRepository(UserRequestEntity);
      await requests.save([
        {
          user,
          isAnonymousPublishing: false,
          originalMessageId: 1,
          isApproved: true,
          isPublished: true,
          publishedAt: new Date(year, 2, 1),
          createdAt: new Date(year, 2, 1),
        },
        {
          user,
          isAnonymousPublishing: false,
          originalMessageId: 2,
          isApproved: false,
          isPublished: false,
          createdAt: new Date(year, 2, 2),
        },
        {
          user,
          isAnonymousPublishing: false,
          originalMessageId: 3,
          isApproved: true,
          isPublished: true,
          publishedAt: new Date(year, 2, 3),
          createdAt: new Date(year, 2, 3),
        },
      ] as any);
    }

    it('генерирует, сохраняет и публикует общую и персональную статистику', async () => {
      const year = 2024;
      await seedYearData(year);
      const yearResults = h.moduleRef.get(YearResultsService);

      const preview = await yearResults.generateYearResults(year);
      expect(preview.users).toHaveLength(1);

      const resultRepo = h.dataSource.getRepository(YearResultEntity);
      const saved = await resultRepo.find({ where: { year } });
      expect(saved).toHaveLength(1);
      expect(saved[0].isPublished).toBe(false);

      h.clearCalls();
      await yearResults.publishGeneralStatistics(year);
      await waitFor(() =>
        expect(
          findCall(
            h.calls,
            'sendMessage',
            (p) => p.chat_id === MEME_CHANNEL && String(p.text).includes('Итоги 2024 года')
          )
        ).toBeDefined()
      );

      h.clearCalls();
      await yearResults.publishPersonalStatistics(year);
      await waitFor(async () => {
        const row = await resultRepo.findOne({ where: { year, userId: 101 } });
        expect(row?.isPublished).toBe(true);
      });
      expect(
        findCall(
          h.calls,
          'sendMessage',
          (p) => Number(p.chat_id) === 101 && String(p.text).includes('Твои итоги 2024 года')
        )
      ).toBeDefined();
    });

    it('cron generateYearResults отправляет предпросмотр владельцу', async () => {
      // Обработчик крона вызывает сервис с реальным AppModule/БД, поэтому
      // fake timers здесь не используем: они ломают асинхронные запросы pg.
      const expectedYear = new Date().getFullYear();

      const cron = h.moduleRef.get(CronService);
      await cron.generateYearResults();

      expect(
        findCall(
          h.calls,
          'sendMessage',
          (p) =>
            p.chat_id === OWNER_ID &&
            String(p.text).includes(`Предпросмотр итогов ${expectedYear} года`)
        )
      ).toBeDefined();
    });
  });
});
