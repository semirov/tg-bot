import { createE2EHarness, findCall, waitFor } from './harness';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { ClientBaseService } from '../../src/app/modules/client/services/client-base.service';
import { EvalStage, ObservedStatus, SourceCategory, SourceStatus } from '../../src/app/modules/parser/constants/parser.constants';
import { ObservedPostEntity } from '../../src/app/modules/parser/entities/observed-post.entity';
import { SourceChannelEntity } from '../../src/app/modules/parser/entities/source-channel.entity';
import { ParserSettingsService } from '../../src/app/modules/parser/services/parser-settings.service';
import { ParserEvaluatorService } from '../../src/app/modules/parser/services/parser-evaluator.service';
import { ParserSelectorService } from '../../src/app/modules/parser/services/parser-selector.service';

jest.mock('axios', () => {
  const instance = {
    post: jest.fn(),
    get: jest.fn(),
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  const axios: any = {
    create: jest.fn(() => instance),
    isAxiosError: jest.fn(() => false),
    get: jest.fn(),
    post: jest.fn(),
  };
  return { __esModule: true, default: axios, ...axios };
});

jest.mock('imghash', () => ({
  hash: jest.fn().mockResolvedValue('e2ee2ee2ee2ee2e1'),
}));

function callbackQueryUpdate(options: {
  data: string;
  messageId?: number;
  userId?: number;
}): Record<string, unknown> {
  return {
    update_id: 8000,
    callback_query: {
      id: `cb-${options.data}`,
      from: { id: options.userId ?? 424242, is_bot: false, first_name: 'Owner', username: 'owner' },
      chat_instance: 'test-chat-instance',
      data: options.data,
      message: {
        message_id: options.messageId ?? 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: options.userId ?? 424242, type: 'private' },
        from: { id: 42, is_bot: true, first_name: 'TestBot' },
        text: 'card',
      },
    },
  };
}

const BASELINE = {
  vmed: 1000,
  rmed: 10,
  p90: 4000,
  posShare: 0.8,
  sampleSize: 10,
  updatedAt: new Date().toISOString(),
};

jest.setTimeout(120_000);

describe('Parser e2e (параллельный конвейер)', () => {
  let harness: Awaited<ReturnType<typeof createE2EHarness>>;
  let client: {
    getMessages: jest.Mock;
    downloadMedia: jest.Mock;
    invoke: jest.Mock;
    getEntity: jest.Mock;
  };

  beforeAll(async () => {
    harness = await createE2EHarness();
    const clientBase = harness.moduleRef.get(ClientBaseService, { strict: false });
    client = {
      getMessages: jest.fn().mockResolvedValue([]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
      invoke: jest.fn().mockResolvedValue({ fullChat: { participantsCount: 10000 } }),
      getEntity: jest.fn().mockResolvedValue({ id: bigInt('8888888888'), username: 'memes_source' }),
    };
    Object.defineProperty(clientBase, 'activeClient', {
      get: () => client,
      configurable: true,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    harness.clearCalls();
    await harness.resetDb();
    // resetDb вычищает настройки — обновляем кэш настроек парсера.
    const settings = harness.moduleRef.get(ParserSettingsService, { strict: false });
    await settings.refresh();
  });

  it('collector → evaluator → selector → карточка «Парсер» в предложке', async () => {
    const sources = harness.dataSource.getRepository(SourceChannelEntity);
    const observed = harness.dataSource.getRepository(ObservedPostEntity);

    await sources.save(
      sources.create({
        chatId: '-1008888888888',
        rawChatId: '8888888888',
        username: 'memes_source',
        title: 'Memes',
        category: SourceCategory.MEMES,
        status: SourceStatus.ACTIVE,
        baseline: BASELINE,
      })
    );

    // 1) Кандидат в БД (логика live/sweep покрыта юнит-тестами).
    const candidate = await observed.save(
      observed.create({
        sourceChatId: '-1008888888888',
        sourceMessageId: 42,
        rawChatId: '8888888888',
        mediaKind: 'photo',
        mediaUniqueId: 'photo-1',
        caption: 'мем',
        status: ObservedStatus.PENDING,
      })
    );

    // 2) Оценщик: перечитывает метрики через юзербота и выставляет скор.
    client.getMessages.mockResolvedValue([
      {
        id: 42,
        views: 4000,
        reactions: {
          results: [{ reaction: new Api.ReactionEmoji({ emoticon: '🔥' }), count: 40 }],
        },
      } as never,
    ]);

    const evaluator = harness.moduleRef.get(ParserEvaluatorService, { strict: false });
    await evaluator.evaluateCandidate(
      { ...candidate, createdAt: new Date(Date.now() - 13 * 3_600_000) } as ObservedPostEntity,
      EvalStage.FINAL,
      client as never
    );

    const scored = await observed.findOneByOrFail({ id: candidate.id });
    expect(scored.status).toBe(ObservedStatus.SCORED);
    expect(scored.evalStage).toBe(EvalStage.FINAL);
    expect(Number(scored.views)).toBe(4000);
    expect(Number(scored.score)).toBeGreaterThan(0);

    // 3) Селектор: доставляет карточку в предложку с raw inline keyboard.
    client.downloadMedia.mockResolvedValue(Buffer.from([1, 2, 3, 4]));

    const selector = harness.moduleRef.get(ParserSelectorService, { strict: false });
    const delivered = await selector.selectAndDeliver();

    expect(delivered).toBe(1);

    const sendPhoto = findCall(harness.calls, 'sendPhoto');
    expect(sendPhoto).toBeDefined();
    expect(String(sendPhoto?.payload.caption)).toContain('🧭 Парсер');
    expect(String(sendPhoto?.payload.caption)).toContain('Memes');
    // Сырая клавиатура (TGB-37): обычный inline_keyboard, а не Menu-прокси.
    const keyboard = sendPhoto?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(Array.isArray(keyboard.inline_keyboard)).toBe(true);
    expect(keyboard.inline_keyboard[0][0].callback_data).toMatch(/^prs:now:\d+$/);

    const deliveredRow = await observed.findOneByOrFail({ id: candidate.id });
    expect(deliveredRow.status).toBe(ObservedStatus.DELIVERED);
    expect(deliveredRow.requestChannelMessageId).toBeDefined();

    // 4) Модерация: «Публикация сейчас» копирует пост в основной канал.
    harness.clearCalls();
    await harness.sendUpdate(
      callbackQueryUpdate({
        data: `prs:now:${candidate.id}`,
        messageId: Number(deliveredRow.requestChannelMessageId),
        userId: 424242,
      })
    );

    await waitFor(() => {
      expect(findCall(harness.calls, 'copyMessage')).toBeDefined();
    });
    const copy = findCall(harness.calls, 'copyMessage');
    expect(copy?.payload.chat_id).toBe(-1001111111111); // MANAGED_CHANNEL

    const publishedRow = await observed.findOneByOrFail({ id: candidate.id });
    expect(publishedRow.status).toBe(ObservedStatus.PUBLISHED);
    expect(publishedRow.publishedMessageId).toBeDefined();
  });

  it('evaluator: кандидат ниже порогов → rejected с причинами', async () => {
    const sources = harness.dataSource.getRepository(SourceChannelEntity);
    const observed = harness.dataSource.getRepository(ObservedPostEntity);

    await sources.save(
      sources.create({
        chatId: '-1008888888888',
        rawChatId: '8888888888',
        username: 'memes_source',
        title: 'Memes',
        category: SourceCategory.MEMES,
        status: SourceStatus.ACTIVE,
        baseline: BASELINE,
      })
    );
    const candidate = await observed.save(
      observed.create({
        sourceChatId: '-1008888888888',
        sourceMessageId: 43,
        mediaKind: 'photo',
        status: ObservedStatus.PENDING,
      })
    );

    client.getMessages.mockResolvedValue([
      { id: 43, views: 10, reactions: { results: [] } } as never,
    ]);

    const evaluator = harness.moduleRef.get(ParserEvaluatorService, { strict: false });
    await evaluator.evaluateCandidate(
      { ...candidate, createdAt: new Date(Date.now() - 13 * 3_600_000) } as ObservedPostEntity,
      EvalStage.FINAL,
      client as never
    );

    const rejected = await observed.findOneByOrFail({ id: candidate.id });
    expect(rejected.status).toBe(ObservedStatus.REJECTED);
    expect(rejected.rejectReason).toContain('views<');
  });

  it('selector: дневной лимит закрывается — доставки нет', async () => {
    const sources = harness.dataSource.getRepository(SourceChannelEntity);
    const observed = harness.dataSource.getRepository(ObservedPostEntity);

    await sources.save(
      sources.create({
        chatId: '-1008888888888',
        rawChatId: '8888888888',
        username: 'memes_source',
        title: 'Memes',
        category: SourceCategory.MEMES,
        status: SourceStatus.ACTIVE,
        baseline: BASELINE,
      })
    );
    for (let index = 0; index < 3; index += 1) {
      await observed.save(
        observed.create({
          sourceChatId: '-1008888888888',
          sourceMessageId: 100 + index,
          mediaKind: 'photo',
          mediaUniqueId: `m${index}`,
          views: 5000,
          reactions: 50,
          score: 8,
          evalStage: EvalStage.FINAL,
          status: ObservedStatus.SCORED,
          rejectReason: null,
        })
      );
    }

    client.getMessages.mockResolvedValue([
      { id: 100 } as never,
      { id: 101 } as never,
      { id: 102 } as never,
    ]);

    const selector = harness.moduleRef.get(ParserSelectorService, { strict: false });
    const settings = harness.moduleRef.get(ParserSettingsService, { strict: false });
    await settings.update({ dailyLimit: 2 });

    const delivered = await selector.selectAndDeliver();
    expect(delivered).toBe(2);

    const deliveredCount = await observed.countBy({ status: ObservedStatus.DELIVERED });
    expect(deliveredCount).toBe(2);
  });

  it('кринж-категория: пометка в подписи карточки', async () => {
    const sources = harness.dataSource.getRepository(SourceChannelEntity);
    const observed = harness.dataSource.getRepository(ObservedPostEntity);

    await sources.save(
      sources.create({
        chatId: '-1007777777777',
        rawChatId: '7777777777',
        username: 'cringe_source',
        title: 'Cringe',
        category: SourceCategory.CRINGE,
        status: SourceStatus.ACTIVE,
        baseline: BASELINE,
      })
    );
    await observed.save(
      observed.create({
        sourceChatId: '-1007777777777',
        sourceMessageId: 9,
        mediaKind: 'photo',
        mediaUniqueId: 'cringe-1',
        views: 500,
        reactions: 20,
        score: 2,
        evalStage: EvalStage.FINAL,
        status: ObservedStatus.SCORED,
        metrics: { nv: 0.5, nr: 2, rr: 0.04, posShare: 0.1, cringeShare: 0.5 },
      })
    );

    client.getMessages.mockResolvedValue([{ id: 9 } as never]);

    const selector = harness.moduleRef.get(ParserSelectorService, { strict: false });
    const delivered = await selector.selectAndDeliver();

    expect(delivered).toBe(1);
    const sendPhoto = findCall(harness.calls, 'sendPhoto');
    expect(String(sendPhoto?.payload.caption)).toContain('кринж');
  });
});
