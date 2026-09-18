import { TestingModule, Test } from '@nestjs/testing';
import { Bot } from 'grammy';
import { Subject } from 'rxjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app/app.module';
import { BotContext } from '../../src/app/modules/bot/interfaces/bot-context.interface';
import { BOT } from '../../src/app/modules/bot/providers/bot.provider';
import { ChannelMonitorBotService } from '../../src/app/modules/channel-monitor/services/channel-monitor-bot.service';
import { ClientBaseService } from '../../src/app/modules/client/services/client-base.service';

/**
 * Раннер grammY не должен стартовать long-polling в тестах: заменяем `run` на no-op.
 * Реальный `sequentialize` и остальные экспорты сохраняем.
 */
jest.mock('@grammyjs/runner', () => {
  const actual = jest.requireActual('@grammyjs/runner');
  return { ...actual, run: jest.fn(() => ({ stop: jest.fn() })) };
});

/**
 * axios поставляется как ESM и не парсится ts-jest; сеть в e2e не нужна.
 */
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

/**
 * В node-сборке grammY Bot API ходит через `node-fetch` (не global.fetch).
 * Заглушка нужна только для стартового `setMyCommands` из BOT_PROVIDER:
 * рантайм-вызовы перехватывает трансформер (см. ниже).
 */
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: true, result: true }),
    text: async () => JSON.stringify({ ok: true, result: true }),
  })),
}));

/** Один исходящий вызов Telegram Bot API, перехваченный тестом. */
export interface TelegramApiCall {
  method: string;
  payload: Record<string, any>;
}

let nextMessageId = 1000;

/** Правдоподобный ответ Bot API для метода. */
function fakeTelegramResult(method: string, payload: Record<string, any>): unknown {
  const chatId = payload?.chat_id ?? payload?.from_chat_id ?? 1;
  const message = {
    message_id: nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    from: { id: 42, is_bot: true, first_name: 'TestBot' },
    text: payload?.text ?? '',
  };
  switch (method) {
    case 'getMe':
      return {
        id: 42,
        is_bot: true,
        first_name: 'TestBot',
        username: 'test_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      };
    case 'getChat':
      return {
        id: chatId,
        type: 'channel',
        title: 'Test Chat',
        username: 'test_channel',
        invite_link: 'https://t.me/+test',
      };
    case 'getChatMember':
      return { status: 'member', user: { id: payload?.user_id ?? 1, is_bot: false, first_name: 'User' } };
    case 'getFile':
      return {
        file_id: payload?.file_id ?? 'file',
        file_unique_id: 'unique',
        file_size: 128,
        file_path: 'photos/file_1.jpg',
      };
    case 'sendMessage':
    case 'copyMessage':
    case 'forwardMessage':
    case 'editMessageText':
    case 'editMessageReplyMarkup':
      return message;
    default:
      return true;
  }
}

/** Сервисы, лезущие в сеть (MTProto/второй бот), заменяем заглушками. */
function createClientBaseStub() {
  return {
    onModuleInit: async () => undefined,
    onApplicationBootstrap: async () => undefined,
    observerChannelPost$: new Subject(),
    bestMemesDaily$: new Subject(),
    lastObserverStatus: async () => false,
    toggleChannelObserver: async () => undefined,
    postDailyBestMeme: async () => undefined,
  };
}

function createChannelMonitorStub() {
  return {
    onModuleInit: async () => undefined,
    onApplicationBootstrap: async () => undefined,
    getLastMeme: async () => null,
    getLastBestMeme: async () => null,
    getRandomMemeByType: async () => null,
  };
}

/** Тестовый стенд: приложение, бот, БД и перехваченные вызовы Telegram. */
export interface E2EHarness {
  moduleRef: TestingModule;
  bot: Bot<BotContext>;
  dataSource: DataSource;
  calls: TelegramApiCall[];
  /** Вызовы Telegram, случившиеся во время старта (например уведомление владельцу). */
  startupCalls: TelegramApiCall[];
  sendUpdate(update: Record<string, any>): Promise<void>;
  clearCalls(): void;
  resetDb(): Promise<void>;
  close(): Promise<void>;
}

/** Настройки тестового стенда. */
export interface E2EHarnessOptions {
  /**
   * Если true — ClientBaseService не подменяется заглушкой, а работает
   * настоящий (его сетевую часть тест мокает сам, например `telegram`).
   */
  realClientBaseService?: boolean;
  /** Дополнительные подмены провайдеров (например DeepSeekService). */
  overrideProviders?: Array<{ provide: unknown; useValue: unknown }>;
}

/** Поднимает приложение и харнес; исходящий Bot API мокается на уровне grammY. */
export async function createE2EHarness(options: E2EHarnessOptions = {}): Promise<E2EHarness> {
  const calls: TelegramApiCall[] = [];

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ChannelMonitorBotService)
    .useValue(createChannelMonitorStub());

  if (!options.realClientBaseService) {
    builder = builder.overrideProvider(ClientBaseService).useValue(createClientBaseStub());
  }

  for (const override of options.overrideProviders ?? []) {
    builder = builder.overrideProvider(override.provide as never).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const bot = moduleRef.get<Bot<BotContext>>(BOT);
  const dataSource = moduleRef.get(DataSource);

  // pg_trgm нужен deduplication-сервису (SIMILARITY). В CI нельзя полагаться на
  // bind-mount initdb (путь раннера не виден docker-демону) — создаём сами.
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  // Канонический способ мокать Bot API в grammY (docs: advanced/transformers) —
  // трансформер на bot.api. Ставим до init(), чтобы поймать уведомление о старте.
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return {
      ok: true,
      result: fakeTelegramResult(method, payload as Record<string, any>),
    } as any;
  });

  // В проде init делает run(); в тесте раннер замокан — инициализируем сами.
  if (!bot.isInited()) {
    await bot.init();
  }

  await moduleRef.init();

  const startupCalls = [...calls];
  calls.length = 0;

  return {
    moduleRef,
    bot,
    dataSource,
    calls,
    startupCalls,
    sendUpdate: (update) => bot.handleUpdate(update as any),
    clearCalls: () => {
      calls.length = 0;
    },
    resetDb: async () => {
      const tables = dataSource.entityMetadatas.map((meta) => `"${meta.tableName}"`).join(', ');
      if (tables) {
        await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE;`);
      }
    },
    close: () => moduleRef.close(),
  };
}

/** Проверяет, что текст — команда, и возвращает сущность bot_command. */
function commandEntities(text: string): { type: string; offset: number; length: number }[] | undefined {
  if (!text.startsWith('/')) return undefined;
  const command = text.split(/\s+/)[0];
  return [{ type: 'bot_command', offset: 0, length: command.length }];
}

/** Собирает update обычного сообщения в личке. */
export function privateMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  userId?: number;
  text: string;
  username?: string;
}): Record<string, any> {
  const userId = options.userId ?? 424242;
  return {
    update_id: options.updateId ?? 1,
    message: {
      message_id: options.messageId ?? 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: {
        id: userId,
        is_bot: false,
        first_name: 'User',
        username: options.username ?? 'user',
      },
      text: options.text,
      entities: commandEntities(options.text),
    },
  };
}

/** Собирает update сообщения в группе. */
export function groupMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  chatId?: number;
  userId?: number;
  text: string;
}): Record<string, any> {
  const chatId = options.chatId ?? -1009999999999;
  const userId = options.userId ?? 555;
  return {
    update_id: options.updateId ?? 2,
    message: {
      message_id: options.messageId ?? 20,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'supergroup', title: 'Test Group' },
      from: { id: userId, is_bot: false, first_name: 'Member' },
      text: options.text,
      entities: commandEntities(options.text),
    },
  };
}

/** Находит первый перехваченный вызов метода с подходящим payload. */
export function findCall(
  calls: TelegramApiCall[],
  method: string,
  predicate: (payload: Record<string, any>) => boolean = () => true
): TelegramApiCall | undefined {
  return calls.find((call) => call.method === method && predicate(call.payload));
}

/**
 * Дожидается выполнения асинхронного побочного эффекта (например подписки
 * на Subject), периодически повторяя проверку. Не использовать с fake timers.
 */
export async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 10000
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
