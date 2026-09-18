import { TestingModule, Test } from '@nestjs/testing';
import { Bot } from 'grammy';
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

/** Один исходящий вызов Telegram API, перехваченный фейковым fetch. */
export interface TelegramApiCall {
  method: string;
  payload: Record<string, any>;
}

let nextMessageId = 1000;

/** Возвращает правдоподобный ответ Telegram Bot API для метода. */
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
      return { id: chatId, type: 'channel', title: 'Test Chat' };
    case 'getChatMember':
      return { status: 'member', user: { id: payload?.user_id ?? 1, is_bot: false, first_name: 'User' } };
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

/** Поднимает приложение и харнес; сеть к Telegram подменяется фейковым fetch. */
export async function createE2EHarness(): Promise<E2EHarness> {
  const calls: TelegramApiCall[] = [];

  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(url).split('/').pop()!.split('?')[0];
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, payload });
    return new Response(JSON.stringify({ ok: true, result: fakeTelegramResult(method, payload) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // Второй (монитор) бот и MTProto-клиент в e2e не нужны — они ходят в сеть.
    .overrideProvider(ChannelMonitorBotService)
    .useValue({ onModuleInit: async () => undefined, onApplicationBootstrap: async () => undefined })
    .overrideProvider(ClientBaseService)
    .useValue({ onModuleInit: async () => undefined, onApplicationBootstrap: async () => undefined })
    .compile();

  await moduleRef.init();

  const bot = moduleRef.get<Bot<BotContext>>(BOT);
  const dataSource = moduleRef.get(DataSource);
  const startupCalls = [...calls];

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
