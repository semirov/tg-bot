import { Logger } from '@nestjs/common';
import { TrollRuntimeSettings } from '../interfaces/troll.interface';
import { TROLL_CALLBACK_REGEXP } from '../constants/troll-callback.enum';
import {
  CRIMINAL_ASSESSMENT_PROMPT,
  FUTURE_ANGRY_PROMPT,
  FUTURE_GOOD_PROMPT,
  JERK_PROMPT,
  MIRROR_PROMPT,
  SARCASM_PROMPT,
  SUMMARY_PROMPT,
  TROLL_CAPABILITIES_REPLY,
} from '../constants/troll-prompts';
import {
  TROLL_SELF_CHECK_CONTEXT_CHARS,
  TROLL_SELF_CHECK_MAX_ATTEMPTS,
} from '../constants/troll-limits';
import { TrollService } from './troll.service';

// DeepSeekService тянет axios (ESM) — подменяем модуль, сервис в тестах подменяется вручную.
jest.mock('./deepseek.service', () => ({ DeepSeekService: class DeepSeekService {} }));

const OWNER = 777;
const CHAT = 100;
const USER = 42;

/** Полный объект рантайм-настроек с безопасными дефолтами для изоляции тестов. */
function settings(over: Partial<TrollRuntimeSettings> = {}): TrollRuntimeSettings {
  return {
    enabled: true,
    criminalEnabled: false,
    criminalThreshold: 0.5,
    criminalHighThreshold: 0.8,
    sarcasmEnabled: false,
    sarcasmChance: 0,
    sarcasmCooldownSec: 0,
    mirrorEnabled: false,
    mirrorChance: 0,
    mirrorCooldownSec: 0,
    reactionEnabled: false,
    reactionChance: 0,
    reactionCooldownSec: 0,
    memeAnnounceEnabled: true,
    memeAnnounceChance: 1,
    jerkEnabled: false,
    addressReactionEnabled: true,
    jerkBatchWindowSec: 15,
    jerkCooldownSec: 180,
    dialogPauseMin: 15,
    analyzeCooldownSec: 0,
    dailyRequestLimit: 2000,
    maxInputChars: 1000,
    selfCheckEnabled: false,
    selfCheckThreshold: 0.6,
    ...over,
  };
}

function makeRepo(): any {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ isActive: true }),
    save: jest.fn(async (entity: any) => entity),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({ identifiers: [] }),
    upsert: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((value: any) => value),
    count: jest.fn().mockResolvedValue(0),
  };
}

function createService() {
  const bot: any = {
    command: jest.fn(),
    on: jest.fn(),
    callbackQuery: jest.fn(),
    api: {
      sendMessage: jest.fn(async () => ({ message_id: 501 })),
      sendChatAction: jest.fn(async () => true),
      setMessageReaction: jest.fn(async () => true),
      forwardMessage: jest.fn(async () => ({ message_id: 502 })),
      copyMessage: jest.fn(async () => ({ message_id: 503 })),
      leaveChat: jest.fn(async () => true),
    },
  };
  const config: any = { ownerId: OWNER };
  const deepSeek: any = {
    complete: jest.fn(async () => ''),
    completeJson: jest.fn(async () => null),
    completeText: jest.fn(async () => null),
  };
  const settingsSvc: any = { current: settings() };
  const chats = makeRepo();
  const history = makeRepo();
  const predictions = makeRepo();
  const defects = makeRepo();
  const memes = makeRepo();
  const service = new TrollService(
    bot,
    config,
    deepSeek,
    settingsSvc,
    chats,
    history,
    predictions,
    defects,
    memes
  );
  return {
    service,
    bot,
    config,
    deepSeek,
    settingsSvc,
    chats,
    history,
    predictions,
    defects,
    memes,
  };
}

function makeCtx(over: any = {}): any {
  return {
    chat: { id: CHAT, type: 'supergroup', title: 'Тестовый чат' },
    from: { id: USER, is_bot: false, first_name: 'Вася', last_name: 'Пупкин', username: 'vasya' },
    me: { id: 999, username: 'trollbot', is_bot: true },
    message: { message_id: 10, text: 'приветствие' },
    api: {
      getChatMember: jest.fn(async () => ({ status: 'member' })),
      sendMessage: jest.fn(async () => ({ message_id: 555 })),
    },
    reply: jest.fn(async () => ({ message_id: 777 })),
    answerCallbackQuery: jest.fn(async () => undefined),
    editMessageText: jest.fn(async () => undefined),
    ...over,
  };
}

function historyRow(over: any = {}): any {
  return {
    id: 1,
    chatId: CHAT,
    role: 'user',
    content: 'привет',
    userId: USER,
    userName: 'Вася',
    messageId: 10,
    replyToMessageId: null,
    createdAt: new Date(),
    ...over,
  };
}

function registeredHandlers(bot: any) {
  const commands = new Map<string, (...args: any[]) => any>();
  for (const call of bot.command.mock.calls) {
    const names = Array.isArray(call[0]) ? call[0] : [call[0]];
    for (const name of names) commands.set(name, call[1]);
  }
  const events = new Map<string, (...args: any[]) => any>();
  for (const call of bot.on.mock.calls) events.set(call[0], call[1]);
  const callback = bot.callbackQuery.mock.calls[0]?.[1];
  return { commands, events, callback };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('TrollService — жизненный цикл и регистрация', () => {
  it('регистрирует команды, обработчики и колбэк владельца, чистит историю', () => {
    const { service, bot, history } = createService();
    service.onModuleInit();

    expect(bot.command).toHaveBeenCalledWith('stat', expect.any(Function));
    expect(bot.command).toHaveBeenCalledWith('future', expect.any(Function));
    expect(bot.command).toHaveBeenCalledWith('meme', expect.any(Function));
    expect(bot.command).toHaveBeenCalledWith(['sumarize', 'summarize'], expect.any(Function));
    expect(bot.on).toHaveBeenCalledWith('my_chat_member', expect.any(Function));
    expect(bot.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(bot.callbackQuery).toHaveBeenCalledWith(TROLL_CALLBACK_REGEXP, expect.any(Function));
    expect(history.delete).toHaveBeenCalled();
  });

  it('нюхает ошибки команд и логирует их', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const name of ['stat', 'future', 'meme', 'sumarize']) {
      const { service, bot } = createService();
      service.onModuleInit();
      const handler = registeredHandlers(bot).commands.get(name)!;
      const ctx: any = {};
      Object.defineProperty(ctx, 'chat', {
        get() {
          throw new Error('boom');
        },
      });
      await handler(ctx, jest.fn());
      expect(error).toHaveBeenCalled();
    }
  });

  it('нюхает ошибки обработчика message и всё равно вызывает next', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, bot } = createService();
    service.onModuleInit();
    const handler = registeredHandlers(bot).events.get('message')!;
    const ctx: any = {};
    Object.defineProperty(ctx, 'chat', {
      get() {
        throw new Error('boom');
      },
    });
    const next = jest.fn();
    await handler(ctx, next);
    expect(error).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('нюхает ошибки my_chat_member и вызывает next', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, bot } = createService();
    service.onModuleInit();
    const handler = registeredHandlers(bot).events.get('my_chat_member')!;
    const ctx: any = {};
    Object.defineProperty(ctx, 'myChatMember', {
      get() {
        throw new Error('boom');
      },
    });
    const next = jest.fn();
    await handler(ctx, next);
    expect(error).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('нюхает ошибки callbackQuery и вызывает next', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, bot } = createService();
    service.onModuleInit();
    const handler = registeredHandlers(bot).callback!;
    const ctx: any = {};
    Object.defineProperty(ctx, 'from', {
      get() {
        throw new Error('boom');
      },
    });
    const next = jest.fn();
    await handler(ctx, next);
    expect(error).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('onModuleDestroy очищает таймеры всех батчей', () => {
    jest.useFakeTimers();
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 15 });
    (service as any).enqueueJerk(makeCtx(), 'привет', settingsSvc.current);
    expect((service as any).jerkBatches.size).toBe(1);
    service.onModuleDestroy();
    expect((service as any).jerkBatches.size).toBe(0);
  });
});

describe('TrollService — чаты и репост мема', () => {
  it('getAllChats возвращает отсортированный список', async () => {
    const { service, chats } = createService();
    chats.find.mockResolvedValue([{ chatId: 1 }]);
    await expect(service.getAllChats()).resolves.toEqual([{ chatId: 1 }]);
    expect(chats.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('setChatActive приводит id к числу', async () => {
    const { service, chats } = createService();
    await service.setChatActive('100', true);
    expect(chats.update).toHaveBeenCalledWith({ chatId: 100 }, { isActive: true });
  });

  it('пропускает репост, если он выключен настройками', async () => {
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ memeAnnounceEnabled: false });
    await service.maybeRepostMeme(-1, 5);
    expect(chats.find).not.toHaveBeenCalled();
  });

  it('пропускает репост, если общий выключатель сработал', async () => {
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ enabled: false });
    await service.maybeRepostMeme(-1, 5);
    expect(chats.find).not.toHaveBeenCalled();
  });

  it('пропускает репост, если шанс не выпал', async () => {
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ memeAnnounceChance: 0 });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    await service.maybeRepostMeme(-1, 5);
    expect(chats.find).not.toHaveBeenCalled();
  });

  it('пропускает репост, если нет активных чатов', async () => {
    const { service, chats } = createService();
    chats.find.mockResolvedValue([]);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await service.maybeRepostMeme(-1, 5);
    expect(chats.find).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it('репостит мем в активные чаты', async () => {
    const { service, chats, bot } = createService();
    chats.find.mockResolvedValue([{ chatId: 100 }, { chatId: 200 }]);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await service.maybeRepostMeme(-1, 5);
    expect(bot.api.forwardMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.forwardMessage).toHaveBeenCalledWith(100, -1, 5);
  });

  it('переживает недоступный чат при рассылке', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, bot } = createService();
    chats.find.mockResolvedValue([{ chatId: 100 }]);
    bot.api.forwardMessage.mockRejectedValue(new Error('нет прав'));
    bot.api.copyMessage.mockRejectedValue(new Error('нет прав'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await service.maybeRepostMeme(-1, 5);
    expect(warn).toHaveBeenCalled();
  });

  it('ловит ошибку обращения к БД при распылке', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, chats } = createService();
    chats.find.mockRejectedValue(new Error('db down'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await service.maybeRepostMeme(-1, 5);
    expect(error).toHaveBeenCalled();
  });

  it('repostMeme повторяет копией, если forward запрещён', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, bot } = createService();
    bot.api.forwardMessage.mockRejectedValue(new Error('copy forbidden'));
    await (service as any).repostMeme(100, '-100', 5);
    expect(bot.api.copyMessage).toHaveBeenCalledWith(100, -100, 5);
    expect(warn).toHaveBeenCalled();
  });
});

describe('TrollService — onMessage', () => {
  it('в личке передаёт управление onPrivateMessage', async () => {
    const { service } = createService();
    const spy = jest.spyOn(service as any, 'onPrivateMessage').mockResolvedValue(undefined);
    const ctx = makeCtx({ chat: { id: 5, type: 'private' } });
    await (service as any).onMessage(ctx);
    expect(spy).toHaveBeenCalledWith(ctx);
  });

  it('игнорирует сообщение без чата', async () => {
    const { service, bot } = createService();
    await (service as any).onMessage(makeCtx({ chat: undefined }));
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('игнорирует не-групповой чат', async () => {
    const { service, bot } = createService();
    await (service as any).onMessage(makeCtx({ chat: { id: 1, type: 'channel' } }));
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('игнорирует сообщение без автора/бота/сообщения', async () => {
    const { service } = createService();
    await (service as any).onMessage(makeCtx({ from: undefined }));
    await (service as any).onMessage(makeCtx({ from: { id: 1, is_bot: true } }));
    await (service as any).onMessage(makeCtx({ message: undefined }));
  });

  it('пропускает всё при выключенном тролле', async () => {
    const { service, settingsSvc, history } = createService();
    settingsSvc.current = settings({ enabled: false });
    await (service as any).onMessage(makeCtx());
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('пропускает чат, который не активирован', async () => {
    const { service, chats, history } = createService();
    chats.findOne.mockResolvedValue({ chatId: CHAT, isActive: false });
    await (service as any).onMessage(makeCtx());
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('пропускает команды', async () => {
    const { service, history } = createService();
    await (service as any).onMessage(makeCtx({ message: { message_id: 1, text: '/stat' } }));
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('отвечает списком команд на вопрос о возможностях', async () => {
    const { service, history } = createService();
    const ctx = makeCtx({ message: { message_id: 10, text: 'что ты умеешь' } });
    await (service as any).onMessage(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      TROLL_CAPABILITIES_REPLY,
      expect.objectContaining({ reply_to_message_id: 10 })
    );
    expect(history.insert).toHaveBeenCalledTimes(2);
  });

  it('распознаёт упоминание по @username и копит обращение', async () => {
    jest.useFakeTimers();
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 10 });
    const ctx = makeCtx({ message: { message_id: 10, text: 'эй @trollbot как дела' } });
    await (service as any).onMessage(ctx);
    expect((service as any).jerkBatches.has(CHAT)).toBe(true);
  });

  it('распознаёт text_mention и отвечает сразу при нулевом окне', async () => {
    const { service, settingsSvc, deepSeek } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 0 });
    deepSeek.complete.mockResolvedValue('ответ');
    const ctx = makeCtx({
      message: {
        message_id: 10,
        text: 'эй',
        entities: [{ type: 'text_mention', user: { id: 999 } }],
      },
    });
    await (service as any).onMessage(ctx);
    await flush();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('распознаёт кличку по слову и копит обращение', async () => {
    jest.useFakeTimers();
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 10 });
    await (service as any).onMessage(
      makeCtx({ message: { message_id: 10, text: 'бот иди сюда' } })
    );
    expect((service as any).jerkBatches.has(CHAT)).toBe(true);
  });

  it('не отвечает на кличку/мат в кулдауне (canAnswerJerk false)', async () => {
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkCooldownSec: 180 });
    (service as any).lastJerkAnswerAt.set(CHAT, Date.now());
    await (service as any).onMessage(makeCtx({ message: { message_id: 10, text: 'мудак' } }));
    expect((service as any).jerkBatches.has(CHAT)).toBe(false);
  });

  it('отвечает на кличку/мат, если кулдаун выключен', async () => {
    jest.useFakeTimers();
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkCooldownSec: 0 });
    await (service as any).onMessage(makeCtx({ message: { message_id: 10, text: 'мудак' } }));
    expect((service as any).jerkBatches.has(CHAT)).toBe(true);
  });

  it('пропускает слишком короткое сообщение', async () => {
    const { service, deepSeek } = createService();
    await (service as any).onMessage(makeCtx({ message: { message_id: 10, text: 'ок' } }));
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('запускает фоновую проверку по УК', async () => {
    const { service, settingsSvc, deepSeek } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    deepSeek.completeJson.mockResolvedValue({ probability: 0.1, articles: [] });
    await (service as any).onMessage(makeCtx({ message: { message_id: 10, text: 'украду мем' } }));
    await flush();
    expect(deepSeek.completeJson).toHaveBeenCalledWith(
      CRIMINAL_ASSESSMENT_PROMPT,
      expect.any(String),
      expect.any(Object)
    );
  });

  it('генерирует кривляние, когда выпало слово', async () => {
    const { service, settingsSvc, deepSeek } = createService();
    settingsSvc.current = settings({ mirrorEnabled: true, mirrorChance: 1 });
    deepSeek.completeText.mockResolvedValue('хуйвет');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const ctx = makeCtx({ message: { message_id: 10, text: 'приветствие' } });
    await (service as any).onMessage(ctx);
    await flush();
    expect(deepSeek.completeText).toHaveBeenCalledWith(
      MIRROR_PROMPT,
      expect.any(String),
      expect.any(Object)
    );
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('не кривляется, когда батч в процессе', async () => {
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ mirrorEnabled: true, mirrorChance: 1, sarcasmEnabled: false });
    (service as any).jerkBatches.set(CHAT, { texts: [], users: new Set() });
    await (service as any).onMessage(makeCtx({ message: { message_id: 10, text: 'приветствие' } }));
    expect((service as any).jerkBatches.has(CHAT)).toBe(true);
  });

  it('переходит к сарказму, если кривляться не из чего', async () => {
    const { service, settingsSvc, deepSeek } = createService();
    settingsSvc.current = settings({ mirrorEnabled: true, sarcasmEnabled: true, sarcasmChance: 1 });
    deepSeek.complete.mockResolvedValue('подкол');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const ctx = makeCtx({ message: { message_id: 10, text: 'ок да' } });
    await (service as any).onMessage(ctx);
    await flush();
    expect(deepSeek.complete).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: SARCASM_PROMPT })]),
      expect.any(Object)
    );
    expect(ctx.reply).toHaveBeenCalled();
  });
});

describe('TrollService — работники обращения (jerk)', () => {
  it('replyAsJerk отправляет ответ и пишет его в историю', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.complete.mockResolvedValue('дерзи');
    const ctx = makeCtx();
    await (service as any).replyAsJerk(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'дерзи',
      expect.objectContaining({ reply_to_message_id: 10 })
    );
    expect(history.insert).toHaveBeenCalled();
  });

  it('replyAsJerk молчит, если модель вернула пусто', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = createService();
    const ctx = makeCtx();
    await (service as any).replyAsJerk(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('flushJerk молча выходит, если батча нет', async () => {
    const { service, deepSeek, bot } = createService();
    await (service as any).flushJerk(CHAT, 10);
    expect(deepSeek.complete).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect((service as any).jerkBatches.has(CHAT)).toBe(false);
  });

  it('flushJerk сбрасывает батч при выключенном тролле', async () => {
    const { service, settingsSvc } = createService();
    (service as any).jerkBatches.set(CHAT, { texts: ['a'], users: new Set(), timer: 1, typingTimer: 2 });
    settingsSvc.current = settings({ enabled: false });
    await (service as any).flushJerk(CHAT, 10);
    expect((service as any).jerkBatches.has(CHAT)).toBe(false);
  });

  it('flushJerk сбрасывает батч в неактивном чате', async () => {
    const { service, chats } = createService();
    (service as any).jerkBatches.set(CHAT, { texts: ['a'], users: new Set(), timer: 1, typingTimer: 2 });
    chats.findOne.mockResolvedValue({ isActive: false });
    await (service as any).flushJerk(CHAT, 10);
    expect((service as any).jerkBatches.has(CHAT)).toBe(false);
  });

  it('flushJerk не отправляет пустой ответ', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    (service as any).jerkBatches.set(CHAT, {
      texts: ['a'],
      users: new Set(['Вася']),
      timer: 1,
      typingTimer: 2,
    });
    deepSeek.complete.mockResolvedValue('');
    await (service as any).flushJerk(CHAT, 10);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('flushJerk отправляет ответ и обновляет кулдаун', async () => {
    const { service, chats, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    (service as any).jerkBatches.set(CHAT, {
      texts: ['a'],
      users: new Set(['Вася']),
      replyToMessageId: 5,
      timer: 1,
      typingTimer: 2,
    });
    deepSeek.complete.mockResolvedValue('дерзи');
    await (service as any).flushJerk(CHAT, 10);
    expect(bot.api.sendMessage).toHaveBeenCalled();
    expect((service as any).lastJerkAnswerAt.get(CHAT)).toBeDefined();
  });

  it('enqueueJerk накапливает несколько сообщений и продлевает дебаунс', () => {
    jest.useFakeTimers();
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 10 });
    const ctx = makeCtx();
    (service as any).enqueueJerk(ctx, 'первое', settingsSvc.current);
    (service as any).enqueueJerk(ctx, 'второе', settingsSvc.current);
    const batch = (service as any).jerkBatches.get(CHAT);
    expect(batch.texts).toEqual(['первое', 'второе']);
  });

  it('enqueueJerk предупреждает о лимите батча', () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 10 });
    const ctx = makeCtx();
    (service as any).jerkBatches.set(CHAT, {
      texts: new Array(20).fill('x'),
      users: new Set(),
      timer: setTimeout(() => undefined, 1000),
      typingTimer: setInterval(() => undefined, 1000),
    });
    (service as any).enqueueJerk(ctx, 'лишнее', settingsSvc.current);
    expect(warn).toHaveBeenCalled();
  });

  it('scheduleJerkFlush работает с таймером без unref', () => {
    const { service } = createService();
    const spy = jest.spyOn(global, 'setTimeout').mockReturnValue(1 as any);
    const timer = (service as any).scheduleJerkFlush(CHAT, 5);
    expect(timer).toBe(1);
    spy.mockRestore();
  });

  it('startTyping сразу шлёт индикатор и обновляет его по интервалу', () => {
    jest.useFakeTimers();
    const { service, bot } = createService();
    const interval = (service as any).startTyping(CHAT);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(4600);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);
    clearInterval(interval);
  });

  it('sendTyping глотает ошибки Telegram', async () => {
    const { service, bot } = createService();
    bot.api.sendChatAction.mockRejectedValue(new Error('no rights'));
    await expect((service as any).sendTyping(CHAT)).resolves.toBeUndefined();
  });
});

describe('TrollService — реакции', () => {
  it('setReaction ставит первую реакцию и запоминает её', async () => {
    const { service, bot } = createService();
    await (service as any).setReaction(CHAT, 10, '🤡');
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(CHAT, 10, [
      { type: 'emoji', emoji: '🤡' },
    ]);
    expect((service as any).lastReactionEmoji.get(CHAT)).toBe('🤡');
  });

  it('setReaction пробует вторую реакцию, если первая запрещена', async () => {
    const { service, bot } = createService();
    bot.api.setMessageReaction
      .mockRejectedValueOnce(new Error('reaction not allowed'))
      .mockResolvedValueOnce(true);
    await (service as any).setReaction(CHAT, 10, '🤡');
    expect(bot.api.setMessageReaction).toHaveBeenCalledTimes(2);
    expect((service as any).lastReactionEmoji.get(CHAT)).toBe('💩');
  });

  it('setReaction предупреждает, если обе реакции не прошли', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, bot } = createService();
    bot.api.setMessageReaction.mockRejectedValue(new Error('no reactions'));
    await (service as any).setReaction(CHAT, 10, '🤡');
    expect(warn).toHaveBeenCalled();
  });

  it('maybeReact ничего не делает при выключенных реакциях', () => {
    const { service, bot } = createService();
    (service as any).maybeReact(makeCtx(), settings({ reactionEnabled: false }));
    expect(bot.api.setMessageReaction).not.toHaveBeenCalled();
  });

  it('maybeReact требует чат и сообщение', async () => {
    const { service, bot } = createService();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const s = settings({ reactionEnabled: true, reactionChance: 1 });
    (service as any).maybeReact(makeCtx({ chat: undefined }), s);
    (service as any).maybeReact(makeCtx({ message: { message_id: undefined } }), s);
    await flush();
    expect(bot.api.setMessageReaction).not.toHaveBeenCalled();
    expect((service as any).lastReactionAt.has(CHAT)).toBe(false);
  });

  it('maybeReact уважает кулдаун', async () => {
    const { service, bot } = createService();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    (service as any).lastReactionAt.set(CHAT, Date.now());
    (service as any).maybeReact(
      makeCtx(),
      settings({ reactionEnabled: true, reactionChance: 1, reactionCooldownSec: 60 })
    );
    await flush();
    expect(bot.api.setMessageReaction).not.toHaveBeenCalled();
  });

  it('maybeReact пропускает бросок без везения', async () => {
    const { service, bot } = createService();
    jest.spyOn(Math, 'random').mockReturnValue(0.9);
    (service as any).maybeReact(makeCtx(), settings({ reactionEnabled: true, reactionChance: 0.1 }));
    await flush();
    expect(bot.api.setMessageReaction).not.toHaveBeenCalled();
    expect((service as any).lastReactionAt.has(CHAT)).toBe(false);
  });

  it('maybeReact чередует эмодзи', async () => {
    const { service, bot } = createService();
    (service as any).lastReactionEmoji.set(CHAT, '🤡');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    (service as any).maybeReact(makeCtx(), settings({ reactionEnabled: true, reactionChance: 1 }));
    await flush();
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(CHAT, 10, [
      { type: 'emoji', emoji: '💩' },
    ]);
  });
});

describe('TrollService — /stat', () => {
  it('пропускает не-групповой чат, бота и выключенный тролль', async () => {
    const { service, settingsSvc } = createService();
    await (service as any).onStatCommand(makeCtx({ chat: { id: 1, type: 'private' } }));
    await (service as any).onStatCommand(makeCtx({ from: { id: 1, is_bot: true } }));
    settingsSvc.current = settings({ enabled: false, criminalEnabled: true });
    await (service as any).onStatCommand(makeCtx());
    settingsSvc.current = settings({ criminalEnabled: false });
    await (service as any).onStatCommand(makeCtx());
  });

  it('пропускает неактивный чат', async () => {
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: false });
    await (service as any).onStatCommand(makeCtx());
  });

  it('отказывает, если не смог проверить участника', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    const ctx = makeCtx();
    ctx.api.getChatMember.mockRejectedValue(new Error('tg'));
    await (service as any).onStatCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Не получилось проверить, что ты участник чата');
    expect(warn).toHaveBeenCalled();
  });

  it('отказывает не-участнику', async () => {
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    const ctx = makeCtx();
    ctx.api.getChatMember.mockResolvedValue({ status: 'left' });
    await (service as any).onStatCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Ты не участник этого чата');
  });

  it('уважает персональный кулдаун', async () => {
    const { service, chats, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    (service as any).lastStatAt.set(`${CHAT}:${USER}`, Date.now());
    const ctx = makeCtx();
    await (service as any).onStatCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Статистику можно запрашивать не так часто, подожди немного'
    );
  });

  it('сообщает, если за сутки сообщений нет', async () => {
    const { service, chats, history, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([]);
    const ctx = makeCtx();
    await (service as any).onStatCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith('🔒 За 24 часа ты ничего не писал — и сроков нет');
  });

  it('честно признаётся, если модель не ответила', async () => {
    const { service, chats, history, deepSeek, bot, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeJson.mockResolvedValue(null);
    const ctx = makeCtx();
    await (service as any).onStatCommand(ctx);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      CHAT,
      'чёт я подвис, попробуй ещё раз',
      expect.any(Object)
    );
  });

  it('считает срок с несколькими статьями и пояснениями', async () => {
    const { service, chats, history, deepSeek, bot, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeJson.mockResolvedValue({
      years: 7,
      articles: [
        { code: 'ст. 158 УК РФ', title: 'Кража', years: 2, reason: 'украл мем' },
        { code: 'ст. 119 УК РФ', title: '', years: 1 },
        { code: '', title: 'без кода', years: 5 },
      ],
    });
    const ctx = makeCtx();
    await (service as any).onStatCommand(ctx);
    expect(bot.api.sendMessage).toHaveBeenCalled();
    const sent = bot.api.sendMessage.mock.calls[0][1];
    expect(sent).toContain('Итого: 3 лет');
  });

  it('сообщает «0 лет», когда статей нет', async () => {
    const { service, chats, history, deepSeek, bot, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeJson.mockResolvedValue({ years: 0, articles: [] });
    const ctx = makeCtx();
    await (service as any).onStatCommand(ctx);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('0 лет — пока чисто');
  });

  it('использует годы из корня, если articles не массив', async () => {
    const { service, chats, history, deepSeek, bot, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeJson.mockResolvedValue({ years: 3, articles: null });
    const ctx = makeCtx();
    await (service as any).onStatCommand(ctx);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('Итого: 3 лет');
  });
});

describe('TrollService — /future', () => {
  it('пропускает неподходящие условия', async () => {
    const { service, settingsSvc, chats } = createService();
    await (service as any).onFutureCommand(makeCtx({ chat: { id: 1, type: 'private' } }));
    await (service as any).onFutureCommand(makeCtx({ from: { id: 1, is_bot: true } }));
    settingsSvc.current = settings({ enabled: false });
    await (service as any).onFutureCommand(makeCtx());
    settingsSvc.current = settings();
    chats.findOne.mockResolvedValue({ isActive: false });
    await (service as any).onFutureCommand(makeCtx());
  });

  it('отдаёт кэш на первых запросах', async () => {
    const { service, chats, predictions, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue({ id: 1, text: 'кэш', requests: 1 });
    await (service as any).onFutureCommand(makeCtx());
    expect(predictions.update).toHaveBeenCalledWith({ id: 1 }, { requests: 2 });
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('гадает обидное после настырных просьб', async () => {
    const { service, chats, predictions, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue({ id: 1, text: 'кэш', requests: 2 });
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue('обидное');
    await (service as any).onFutureCommand(makeCtx());
    expect(deepSeek.completeText).toHaveBeenCalledWith(
      FUTURE_ANGRY_PROMPT,
      expect.any(String),
      expect.any(Object)
    );
    expect(predictions.update).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ text: expect.any(String), requests: 3 })
    );
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('возвращает кэш, если обидное не получилось', async () => {
    const { service, chats, predictions, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue({ id: 1, text: 'кэш', requests: 2 });
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue(null);
    await (service as any).onFutureCommand(makeCtx());
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('генерирует новое плохое предсказание и сохраняет его', async () => {
    const { service, chats, predictions, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue(null);
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue('плохое');
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    await (service as any).onFutureCommand(makeCtx());
    expect(predictions.insert).toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('генерирует доброе предсказание при редком шансе', async () => {
    const { service, chats, predictions, deepSeek } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue(null);
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue('доброе');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await (service as any).onFutureCommand(makeCtx());
    expect(deepSeek.completeText).toHaveBeenCalledWith(
      FUTURE_GOOD_PROMPT,
      expect.any(String),
      expect.any(Object)
    );
  });

  it('молчит, если новое предсказание пустое', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, predictions, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue(null);
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue(null);
    await (service as any).onFutureCommand(makeCtx());
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('предупреждает, если предсказание не удалось сохранить', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, predictions, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue(null);
    predictions.find.mockResolvedValue([]);
    predictions.insert.mockRejectedValue(new Error('db'));
    deepSeek.completeText.mockResolvedValue('плохое');
    await (service as any).onFutureCommand(makeCtx());
    expect(warn).toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('recentPredictions переживает ошибку чтения', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, predictions } = createService();
    predictions.find.mockRejectedValue(new Error('db'));
    await expect((service as any).recentPredictions(CHAT)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('recentPredictions чистит и ограничивает список', async () => {
    const { service, predictions } = createService();
    predictions.find.mockResolvedValue([
      historyRow({ text: 'одно' }),
      { text: '' },
      { text: null },
    ]);
    const result = await (service as any).recentPredictions(CHAT, ['доп']);
    expect(result).toContain('доп');
  });

  it('pickFutureTechnique возвращает приём', () => {
    const { service } = createService();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(typeof (service as any).pickFutureTechnique()).toBe('string');
  });

  it('buildPredictionRequest добавляет список прошлого при наличии', () => {
    const { service } = createService();
    const withAvoid = (service as any).buildPredictionRequest(
      { first_name: 'Вася', id: 1 },
      ['старое'],
      'приём'
    );
    expect(withAvoid).toContain('старое');
    const withoutAvoid = (service as any).buildPredictionRequest(undefined, [], 'приём');
    expect(withoutAvoid).not.toContain('Уже говорил');
  });
});

describe('TrollService — /meme', () => {
  it('пропускает неподходящие условия', async () => {
    const { service, settingsSvc, chats } = createService();
    await (service as any).onMemeCommand(makeCtx({ chat: { id: 1, type: 'private' } }));
    await (service as any).onMemeCommand(makeCtx({ from: { id: 1, is_bot: true } }));
    settingsSvc.current = settings({ enabled: false });
    await (service as any).onMemeCommand(makeCtx());
    settingsSvc.current = settings();
    chats.findOne.mockResolvedValue({ isActive: false });
    await (service as any).onMemeCommand(makeCtx());
  });

  it('отказывает грубо на кулдауне', async () => {
    const { service, chats, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    (service as any).lastMemeAt.set(`${CHAT}:${USER}`, Date.now());
    deepSeek.completeText.mockResolvedValue(null);
    await (service as any).onMemeCommand(makeCtx());
    expect(bot.api.sendMessage).toHaveBeenCalledWith(CHAT, 'нет, не сейчас', expect.any(Object));
  });

  it('отказывает грубо, если мемов нет', async () => {
    const { service, chats, memes, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    memes.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue(null);
    await (service as any).onMemeCommand(makeCtx());
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('репостит случайный мем', async () => {
    const { service, chats, memes, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    memes.find.mockResolvedValue([{ id: 1, channelId: '-100', messageId: 5 }]);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await (service as any).onMemeCommand(makeCtx());
    expect(bot.api.forwardMessage).toHaveBeenCalledWith(CHAT, -100, 5);
  });

  it('удаляет мёртвый мем и в итоге отказывает', async () => {
    const { service, chats, memes, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    memes.find.mockResolvedValue([{ id: 1, channelId: '-100', messageId: 5 }]);
    bot.api.forwardMessage.mockRejectedValue(new Error('message to forward not found'));
    bot.api.copyMessage.mockRejectedValue(new Error('message to copy not found'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await (service as any).onMemeCommand(makeCtx());
    expect(memes.delete).toHaveBeenCalledWith({ id: 1 });
  });

  it('переживает ошибку удаления мёртвого мема', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, memes, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    memes.find.mockResolvedValue([{ id: 1, channelId: '-100', messageId: 5 }]);
    bot.api.forwardMessage.mockRejectedValue(new Error('message to forward not found'));
    bot.api.copyMessage.mockRejectedValue(new Error('message to copy not found'));
    memes.delete.mockRejectedValue(new Error('db'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await (service as any).onMemeCommand(makeCtx());
    expect(warn).toHaveBeenCalled();
  });

  it('пробует следующий мем при прочих ошибках', async () => {
    const { service, chats, memes, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    memes.find.mockResolvedValue([
      { id: 1, channelId: '-100', messageId: 5 },
      { id: 2, channelId: '-100', messageId: 6 },
    ]);
    bot.api.forwardMessage.mockRejectedValue(new Error('flood wait'));
    bot.api.copyMessage.mockRejectedValue(new Error('flood wait'));
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await (service as any).onMemeCommand(makeCtx());
    expect(memes.delete).not.toHaveBeenCalled();
  });

  it('denyRudely подставляет запасную фразу без ответа модели', async () => {
    const { service, deepSeek, bot } = createService();
    deepSeek.completeText.mockResolvedValue(null);
    const ctx = makeCtx();
    await (service as any).denyRudely(ctx, 'причина');
    expect(bot.api.sendMessage).toHaveBeenCalledWith(CHAT, 'нет, не сейчас', expect.any(Object));
  });
});

describe('TrollService — /sumarize', () => {
  it('пропускает неподходящие условия', async () => {
    const { service, settingsSvc, chats } = createService();
    await (service as any).onSummaryCommand(makeCtx({ chat: { id: 1, type: 'private' } }));
    await (service as any).onSummaryCommand(makeCtx({ from: { id: 1, is_bot: true } }));
    settingsSvc.current = settings({ enabled: false });
    await (service as any).onSummaryCommand(makeCtx());
    settingsSvc.current = settings();
    chats.findOne.mockResolvedValue({ isActive: false });
    await (service as any).onSummaryCommand(makeCtx());
  });

  it('отказывает на общем кулдауне чата', async () => {
    const { service, chats, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true, lastSummaryAt: new Date() });
    deepSeek.completeText.mockResolvedValue(null);
    await (service as any).onSummaryCommand(makeCtx());
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('сообщает, что истории нет вообще', async () => {
    const { service, chats, history, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true, lastSummaryAt: null });
    history.find.mockResolvedValue([]);
    await (service as any).onSummaryCommand(makeCtx());
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      CHAT,
      'тут вообще ничего не писали, пересказывать нечего',
      expect.any(Object)
    );
  });

  it('пересказывает и двигает метку окна', async () => {
    const { service, chats, history, deepSeek } = createService();
    chats.findOne.mockResolvedValue({ isActive: true, lastSummaryAt: null });
    history.find.mockResolvedValue([historyRow({ userName: null, userId: null })]);
    deepSeek.completeText.mockResolvedValue('саммари');
    await (service as any).onSummaryCommand(makeCtx());
    expect(chats.update).toHaveBeenCalledWith(
      { chatId: CHAT },
      expect.objectContaining({ lastSummaryAt: expect.any(Date) })
    );
    expect(history.insert).toHaveBeenCalled();
  });

  it('берёт последние сообщения, если окно пустое', async () => {
    const { service, chats, history, deepSeek } = createService();
    chats.findOne.mockResolvedValue({ isActive: true, lastSummaryAt: null });
    history.find.mockResolvedValueOnce([]).mockResolvedValueOnce([historyRow()]);
    deepSeek.completeText.mockResolvedValue('саммари');
    await (service as any).onSummaryCommand(makeCtx());
    expect(deepSeek.completeText).toHaveBeenCalledWith(
      SUMMARY_PROMPT,
      expect.any(String),
      expect.any(Object)
    );
  });

  it('честно признаётся при пустом ответе модели', async () => {
    const { service, chats, history, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true, lastSummaryAt: null });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeText.mockResolvedValue(null);
    await (service as any).onSummaryCommand(makeCtx());
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      CHAT,
      'чёт я подвис, попробуй позже',
      expect.any(Object)
    );
  });

  it('не двигает метку, если отправка не удалась', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, chats, history, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true, lastSummaryAt: null });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeText.mockResolvedValue('саммари');
    bot.api.sendMessage.mockRejectedValue(new Error('tg'));
    await (service as any).onSummaryCommand(makeCtx());
    expect(warn).toHaveBeenCalled();
    expect(chats.update).not.toHaveBeenCalled();
  });
});

describe('TrollService — членство и решение владельца', () => {
  it('onMyChatMember игнорирует отсутствие/не-группу', async () => {
    const { service } = createService();
    await (service as any).onMyChatMember({ myChatMember: undefined });
    await (service as any).onMyChatMember({
      myChatMember: { chat: { id: 1, type: 'private' }, new_chat_member: {}, old_chat_member: {} },
    });
  });

  it('onMyChatMember деактивирует чат при выходе бота', async () => {
    const { service, chats } = createService();
    await (service as any).onMyChatMember({
      myChatMember: {
        chat: { id: CHAT, type: 'supergroup', title: 'x' },
        new_chat_member: { status: 'left' },
        old_chat_member: { status: 'member' },
        from: { id: 1 },
      },
    });
    expect(chats.update).toHaveBeenCalledWith({ chatId: CHAT }, { isActive: false });
  });

  it('onMyChatMember не делает ничего при обычной смене статуса', async () => {
    const { service, chats } = createService();
    await (service as any).onMyChatMember({
      myChatMember: {
        chat: { id: CHAT, type: 'supergroup', title: 'x' },
        new_chat_member: { status: 'administrator' },
        old_chat_member: { status: 'member' },
        from: { id: 1 },
      },
    });
    expect(chats.upsert).not.toHaveBeenCalled();
  });

  it('onMyChatMember уведомляет владельца о новом чате', async () => {
    const { service, chats, bot, config } = createService();
    await (service as any).onMyChatMember({
      myChatMember: {
        chat: { id: CHAT, type: 'supergroup', title: 'Новый' },
        new_chat_member: { status: 'member' },
        old_chat_member: { status: 'left' },
        from: { id: 5, first_name: 'Петя', username: 'petya' },
      },
    });
    expect(chats.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, isActive: false }),
      ['chatId']
    );
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      config.ownerId,
      expect.any(String),
      expect.any(Object)
    );
  });

  it('notifyOwnerAboutNewChat логирует ошибку отправки', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, bot } = createService();
    bot.api.sendMessage.mockRejectedValue(new Error('tg'));
    await (service as any).notifyOwnerAboutNewChat(CHAT, undefined, {
      id: 5,
      first_name: '',
      username: undefined,
    });
    expect(error).toHaveBeenCalled();
  });

  it('onOwnerDecision отклоняет чужие нажатия', async () => {
    const { service } = createService();
    const ctx = makeCtx({ from: { id: 1 } });
    await (service as any).onOwnerDecision(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Эта кнопка не для тебя');
  });

  it('onOwnerDecision молчит без совпадения', async () => {
    const { service } = createService();
    const ctx = makeCtx({ from: { id: OWNER }, match: undefined });
    await (service as any).onOwnerDecision(ctx);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('onOwnerDecision активирует чат по approve', async () => {
    const { service, chats, bot } = createService();
    const ctx = makeCtx({ from: { id: OWNER }, match: ['troll:approve:100', 'approve', '100'] });
    await (service as any).onOwnerDecision(ctx);
    expect(chats.update).toHaveBeenCalledWith({ chatId: CHAT }, { isActive: true });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Подтверждено');
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('onOwnerDecision деактивирует чат и выходит по reject', async () => {
    const { service, chats, bot } = createService();
    const ctx = makeCtx({ from: { id: OWNER }, match: ['troll:reject:100', 'reject', '100'] });
    await (service as any).onOwnerDecision(ctx);
    expect(chats.update).toHaveBeenCalledWith({ chatId: CHAT }, { isActive: false });
    expect(bot.api.leaveChat).toHaveBeenCalledWith(CHAT);
  });

  it('onOwnerDecision переживает ошибку выхода и редактирования', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, bot } = createService();
    bot.api.leaveChat.mockRejectedValue(new Error('tg'));
    const ctx = makeCtx({
      from: { id: OWNER },
      match: ['troll:reject:100', 'reject', '100'],
      editMessageText: jest.fn(async () => {
        throw new Error('edit');
      }),
    });
    await (service as any).onOwnerDecision(ctx);
    expect(warn).toHaveBeenCalled();
  });
});

describe('TrollService — личные сообщения и дефекты', () => {
  it('onPrivateMessage пропускает не владельца и пустой текст', async () => {
    const { service } = createService();
    await (service as any).onPrivateMessage(makeCtx({ from: { id: 1 } }));
    await (service as any).onPrivateMessage(
      makeCtx({
        chat: { id: 5, type: 'private' },
        from: { id: OWNER },
        message: { message_id: 1, text: '   ' },
      })
    );
  });

  it('на форвард без совпадения честно отвечает', async () => {
    const { service, chats, history, bot } = createService();
    chats.find.mockResolvedValue([]);
    history.find.mockResolvedValue([]);
    const ctx = makeCtx({
      chat: { id: 5, type: 'private' },
      from: { id: OWNER },
      message: { message_id: 1, text: 'ответ', forward_origin: { date: 1000 } },
    });
    await (service as any).onPrivateMessage(ctx);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      5,
      expect.stringContaining('не нашёл'),
      expect.any(Object)
    );
  });

  it('на обычный текст без совпадения молчит', async () => {
    const { service, chats, history, bot } = createService();
    chats.find.mockResolvedValue([]);
    history.find.mockResolvedValue([]);
    const ctx = makeCtx({
      chat: { id: 5, type: 'private' },
      from: { id: OWNER },
      message: { message_id: 1, text: 'ответ' },
    });
    await (service as any).onPrivateMessage(ctx);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('отклоняет разбор, если чат выключен', async () => {
    const { service, chats, history, bot } = createService();
    chats.find.mockResolvedValue([{ chatId: CHAT, isActive: true }]);
    history.find.mockResolvedValue([
      historyRow({ role: 'assistant', content: 'ответ бота', userName: 'бот' }),
    ]);
    chats.findOne.mockResolvedValue({ chatId: CHAT, isActive: false, title: 'Чат' });
    const ctx = makeCtx({
      chat: { id: 5, type: 'private' },
      from: { id: OWNER },
      message: { message_id: 1, text: 'ответ бота' },
    });
    await (service as any).onPrivateMessage(ctx);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      5,
      expect.stringContaining('тролль там выключен'),
      expect.any(Object)
    );
  });

  it('записывает дефект и отправляет отчёт владельцу', async () => {
    const { service, chats, history, deepSeek, defects, bot } = createService();
    chats.find.mockResolvedValue([{ chatId: CHAT, isActive: true }]);
    history.find.mockResolvedValue([
      historyRow({
        role: 'assistant',
        content: 'ответ бота',
        userName: 'бот',
        id: 3,
        messageId: 20,
        replyToMessageId: 15,
      }),
      historyRow({ role: 'user', content: 'вопрос', id: 2, messageId: 15, userName: 'Вася', userId: USER }),
    ]);
    chats.findOne.mockResolvedValue({ chatId: CHAT, isActive: true, title: 'Чат' });
    history.findOne.mockResolvedValue(historyRow({ role: 'user', content: 'вопрос', messageId: 15 }));
    deepSeek.completeJson.mockResolvedValue({
      severity: 'high',
      summary: 'плохо',
      problems: ['не то', 5],
      fixSuggestions: ['надо так'],
    });
    defects.create.mockImplementation((v: any) => ({ ...v, id: 42 }));
    defects.save.mockImplementation(async (v: any) => v);
    const ctx = makeCtx({
      chat: { id: 5, type: 'private' },
      from: { id: OWNER },
      message: { message_id: 1, text: 'ответ бота' },
    });
    await (service as any).onPrivateMessage(ctx);
    expect(defects.save).toHaveBeenCalled();
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      5,
      expect.stringContaining('Дефект #42'),
      expect.any(Object)
    );
  });

  it('findReportedAnswer возвращает null без активных чатов', async () => {
    const { service, chats } = createService();
    chats.find.mockResolvedValue([]);
    await expect((service as any).findReportedAnswer('текст')).resolves.toBeNull();
  });

  it('findReportedAnswer ищет в узком окне при известной дате', async () => {
    const { service, chats, history } = createService();
    const sentAt = new Date();
    chats.find.mockResolvedValue([{ chatId: CHAT }]);
    history.find.mockResolvedValue([
      historyRow({ role: 'assistant', content: 'ответ', createdAt: sentAt }),
    ]);
    const result = await (service as any).findReportedAnswer(
      'ответ',
      Math.floor(sentAt.getTime() / 1000)
    );
    expect(result).not.toBeNull();
    expect(history.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: 'assistant' }) })
    );
  });

  it('findReportedAnswer логирует отсутствие совпадений', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, chats, history } = createService();
    chats.find.mockResolvedValue([{ chatId: CHAT }]);
    history.find.mockResolvedValue([historyRow({ role: 'assistant', content: 'другое' })]);
    await expect((service as any).findReportedAnswer('нет такого')).resolves.toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('findDefectReplyTo возвращает null без replyToMessageId', async () => {
    const { service } = createService();
    await expect((service as any).findDefectReplyTo({ replyToMessageId: null })).resolves.toBeNull();
  });

  it('findDefectReplyTo ищет реплику по номеру', async () => {
    const { service, history } = createService();
    history.findOne.mockResolvedValue(historyRow());
    await (service as any).findDefectReplyTo({ chatId: CHAT, replyToMessageId: 15 });
    expect(history.findOne).toHaveBeenCalledWith({
      where: { chatId: CHAT, messageId: 15 },
    });
  });

  it('buildDefectContext строит расшифровку', async () => {
    const { service, history } = createService();
    history.find.mockResolvedValue([
      historyRow({ role: 'assistant', content: 'ответ', createdAt: new Date(Date.now() - 600000) }),
      historyRow({ content: 'вопрос', createdAt: new Date() }),
    ]);
    const result = await (service as any).buildDefectContext({ chatId: CHAT, id: 5 });
    expect(typeof result).toBe('string');
  });

  it('diagnoseDefect возвращает заглушку без ответа модели', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = createService();
    const result = await (service as any).diagnoseDefect({
      answer: 'a',
      replyTo: null,
      context: '',
      sourceChatTitle: null,
    });
    expect(result.severity).toBe('unknown');
    expect(warn).toHaveBeenCalled();
  });

  it('diagnoseDefect разбирает ответ модели', async () => {
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue({
      severity: 'medium',
      summary: 'суть',
      problems: ['п1', 7],
      fixSuggestions: ['ф1'],
    });
    const result = await (service as any).diagnoseDefect({
      answer: 'a',
      replyTo: historyRow({ userName: 'Вася', userId: USER, content: 'вопрос' }),
      context: 'ctx',
      sourceChatTitle: 'Чат',
    });
    expect(result.severity).toBe('medium');
    expect(result.problems).toEqual(['п1']);
    expect(result.text).toContain('суть');
  });

  it('formatDefectReport собирает оба варианта отчёта', () => {
    const { service } = createService();
    const defect = {
      id: 1,
      sourceChatId: CHAT,
      sourceChatTitle: 'Чат',
      botAnswer: 'a',
      matchKind: 'exact',
    };
    const answer = historyRow({ role: 'assistant', content: 'ответ бота' });
    const withReply = (service as any).formatDefectReport(
      defect,
      answer,
      historyRow({ userName: 'Вася', userId: USER, content: 'вопрос' }),
      { severity: 'high', summary: 'с', problems: ['п'], fixes: ['ф'] }
    );
    expect(withReply).toContain('бот отвечал');
    expect(withReply).toContain('что не так');
    expect(withReply).toContain('как надо было');

    const withoutReply = (service as any).formatDefectReport(
      { ...defect, sourceChatId: null, sourceChatTitle: null },
      answer,
      null,
      { severity: 'low', summary: '', problems: [], fixes: [] }
    );
    expect(withoutReply).toContain('не реплаем');
  });
});

describe('TrollService — самопроверка ответа', () => {
  it('generateCheckedReply без самопроверки делает одну попытку', async () => {
    const { service, deepSeek, history } = createService();
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.complete.mockResolvedValue('ответ');
    const result = await (service as any).generateCheckedReply(
      JERK_PROMPT,
      CHAT,
      { label: 'тест' },
      undefined,
      (raw: string) => raw
    );
    expect(result).toBe('ответ');
    expect(deepSeek.complete).toHaveBeenCalledTimes(1);
  });

  it('generateCheckedReply принимает ответ с хорошей оценкой', async () => {
    const { service, deepSeek, history, settingsSvc } = createService();
    settingsSvc.current = settings({ selfCheckEnabled: true, selfCheckThreshold: 0.6 });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.complete.mockResolvedValue('ответ');
    deepSeek.completeJson.mockResolvedValue({ score: 0.9, issues: [] });
    const result = await (service as any).generateCheckedReply(
      JERK_PROMPT,
      CHAT,
      { label: 'тест' },
      undefined,
      (raw: string) => raw
    );
    expect(result).toBe('ответ');
  });

  it('generateCheckedReply переписывает при низкой оценке', async () => {
    const { service, deepSeek, history, settingsSvc } = createService();
    settingsSvc.current = settings({ selfCheckEnabled: true, selfCheckThreshold: 0.9 });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.complete.mockResolvedValueOnce('первый').mockResolvedValueOnce('второй');
    deepSeek.completeJson
      .mockResolvedValueOnce({ score: 0.5, issues: ['плохо'] })
      .mockResolvedValueOnce({ score: 0.95, issues: [] });
    const result = await (service as any).generateCheckedReply(
      JERK_PROMPT,
      CHAT,
      { label: 'тест' },
      undefined,
      (raw: string) => raw
    );
    expect(result).toBe('второй');
    expect(deepSeek.complete).toHaveBeenCalledTimes(2);
    expect(deepSeek.complete.mock.calls[1][0][1].content).toContain('ПОПЫТКА 2');
  });

  it('generateCheckedReply возвращает лучший вариант после исчерпания попыток', async () => {
    const { service, deepSeek, history, settingsSvc } = createService();
    settingsSvc.current = settings({ selfCheckEnabled: true, selfCheckThreshold: 1 });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.complete.mockResolvedValue('вариант');
    deepSeek.completeJson.mockResolvedValue({ score: 0.2, issues: ['плохо'] });
    const result = await (service as any).generateCheckedReply(
      JERK_PROMPT,
      CHAT,
      { label: 'тест' },
      undefined,
      (raw: string) => raw
    );
    expect(result).toBe('вариант');
    expect(deepSeek.complete).toHaveBeenCalledTimes(TROLL_SELF_CHECK_MAX_ATTEMPTS);
  });

  it('generateCheckedReply возвращает null без вариантов', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, deepSeek, history, settingsSvc } = createService();
    settingsSvc.current = settings({ selfCheckEnabled: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.complete.mockResolvedValue('');
    const result = await (service as any).generateCheckedReply(
      JERK_PROMPT,
      CHAT,
      { label: 'тест' },
      undefined,
      (raw: string) => raw
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('reviewReply считает неответившего ревизора приёмлемым', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = createService();
    await expect((service as any).reviewReply(CHAT, 'т', 'ответ')).resolves.toEqual({
      score: 1,
      issues: [],
    });
    expect(warn).toHaveBeenCalled();
  });

  it('reviewReply обрезает хвост и нормализует оценку', async () => {
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue({ score: 2, issues: ['a', 3] });
    const long = 'x'.repeat(TROLL_SELF_CHECK_CONTEXT_CHARS + 100);
    const result = await (service as any).reviewReply(CHAT, long, 'ответ', 'тест');
    expect(result.score).toBe(1);
    expect(result.issues).toEqual(['a']);
  });

  it('reviewReply отдаёт 0 при нечисловой оценке', async () => {
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue({ score: 'abc', issues: null });
    const result = await (service as any).reviewReply(CHAT, 'т', 'ответ');
    expect(result.score).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it('buildConversationMessages собирает system и user', async () => {
    const { service, history } = createService();
    history.find.mockResolvedValue([historyRow()]);
    const messages = await (service as any).buildConversationMessages('система', CHAT);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'система' });
  });

  it('buildConversationParts формирует директиву с фокусом и без', async () => {
    const { service, history } = createService();
    history.find.mockResolvedValue([historyRow()]);
    const withFocus = await (service as any).buildConversationParts(CHAT, {
      userId: USER,
      userName: 'Вася',
    });
    expect(withFocus.directive).toContain('Вася');
    const nameOnly = await (service as any).buildConversationParts(CHAT, { userName: 'Вася' });
    expect(nameOnly.directive).toContain('Вася');
    const noFocus = await (service as any).buildConversationParts(CHAT);
    expect(noFocus.directive).toContain('не путай собеседников');
  });

  it('formatTranscript помечает паузы и роли', () => {
    const { service } = createService();
    const context = [
      { kind: 'pause', gapMs: 3600000 },
      { kind: 'message', row: historyRow({ role: 'assistant', content: 'ответ бота' }) },
      { kind: 'message', row: historyRow({ userId: null, userName: null, content: 'аноним' }) },
    ];
    const text = (service as any).formatTranscript(CHAT, context);
    expect(text).toContain('разрыв беседы');
    expect(text).toContain('бот');
    expect(text).toContain('участник');
  });
});

describe('TrollService — проверка УК', () => {
  it('checkCriminalArticle выходит без chatId', async () => {
    const { service, deepSeek } = createService();
    await (service as any).checkCriminalArticle(makeCtx({ chat: undefined }), 'текст', settings());
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('checkCriminalArticle не плодит параллельные проверки', async () => {
    const { service, deepSeek } = createService();
    (service as any).analyzingChats.add(CHAT);
    (service as any).lastAnalysisAt.set(CHAT, 111);
    await (service as any).checkCriminalArticle(makeCtx(), 'текст', settings());
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
    expect((service as any).analyzingChats.has(CHAT)).toBe(true);
    expect((service as any).lastAnalysisAt.get(CHAT)).toBe(111);
  });

  it('checkCriminalArticle уважает кулдаун', async () => {
    const { service, deepSeek } = createService();
    (service as any).lastAnalysisAt.set(CHAT, Date.now());
    await (service as any).checkCriminalArticle(
      makeCtx(),
      'текст',
      settings({ analyzeCooldownSec: 60 })
    );
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
    expect((service as any).analyzingChats.has(CHAT)).toBe(false);
  });

  it('checkCriminalArticle предупреждает о битом ответе модели', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue(null);
    await (service as any).checkCriminalArticle(makeCtx(), 'украду мем', settings());
    expect(warn).toHaveBeenCalled();
    expect((service as any).analyzingChats.has(CHAT)).toBe(false);
  });

  it('checkCriminalArticle молчит ниже порога', async () => {
    const { service, deepSeek, bot } = createService();
    deepSeek.completeJson.mockResolvedValue({ probability: 0.1, articles: [] });
    await (service as any).checkCriminalArticle(makeCtx(), 'украду мем', settings());
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('checkCriminalArticle отвечает статьёй выше порога', async () => {
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue({
      probability: 2,
      articles: [{ code: 'ст. 158', title: 'Кража', reason: 'украл' }],
      reason: 'общий',
    });
    const ctx = makeCtx();
    await (service as any).checkCriminalArticle(ctx, 'украду мем', settings());
    expect(ctx.reply).toHaveBeenCalled();
  });
});

describe('TrollService — кривляние и сарказм', () => {
  it('pickMirrorWord не кривляется при активном батче/кулдауне', () => {
    const { service } = createService();
    (service as any).jerkBatches.set(CHAT, {});
    expect((service as any).pickMirrorWord(CHAT, 'приветствие', settings())).toBeNull();
    (service as any).jerkBatches.clear();
    (service as any).lastMirrorAt.set(CHAT, Date.now());
    expect(
      (service as any).pickMirrorWord(CHAT, 'приветствие', settings({ mirrorCooldownSec: 60 }))
    ).toBeNull();
  });

  it('pickMirrorWord не кривляется без длинных слов и без везения', () => {
    const { service } = createService();
    expect((service as any).pickMirrorWord(CHAT, 'ок да', settings({ mirrorChance: 1 }))).toBeNull();
    jest.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(
      (service as any).pickMirrorWord(CHAT, 'приветствие', settings({ mirrorChance: 0.1 }))
    ).toBeNull();
  });

  it('pickMirrorWord возвращает слово и ставит кулдаун', () => {
    const { service } = createService();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const word = (service as any).pickMirrorWord(
      CHAT,
      'приветствие',
      settings({ mirrorChance: 1 })
    );
    expect(word).toBe('приветствие');
    expect((service as any).lastMirrorAt.get(CHAT)).toBeDefined();
  });

  it('generateMirror отправляет переделанное слово', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.completeText.mockResolvedValue('хуйвет');
    const random = jest.spyOn(Math, 'random');
    for (const value of [0, 0.3, 0.6]) {
      random.mockReturnValue(value);
      const ctx = makeCtx();
      await (service as any).generateMirror(ctx, 'привет', settings({ maxInputChars: 100 }));
      expect(ctx.reply).toHaveBeenCalled();
    }
    expect(history.insert).toHaveBeenCalled();
  });

  it('generateMirror молчит при пустом ответе', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, deepSeek } = createService();
    deepSeek.completeText.mockResolvedValue('!!!');
    const ctx = makeCtx();
    await (service as any).generateMirror(ctx, 'привет', settings());
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('generateMirror выходит без chatId', async () => {
    const { service, deepSeek } = createService();
    const ctx = makeCtx({ chat: undefined });
    await (service as any).generateMirror(ctx, 'привет', settings());
    expect(deepSeek.completeText).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('normalizeMirrorWord оставляет первое слово без посторонних символов', () => {
    const { service } = createService();
    expect((service as any).normalizeMirrorWord('  хуйвет!!!  таки')).toBe('хуйвет');
    expect((service as any).normalizeMirrorWord('---')).toBe('');
  });

  it('replyWithSarcasm выходит без chatId и в кулдауне', async () => {
    const { service, deepSeek } = createService();
    await (service as any).replyWithSarcasm(makeCtx({ chat: undefined }), settings());
    (service as any).lastSarcasmAt.set(CHAT, Date.now());
    await (service as any).replyWithSarcasm(makeCtx(), settings({ sarcasmCooldownSec: 60 }));
    expect(deepSeek.complete).not.toHaveBeenCalled();
  });

  it('replyWithSarcasm не срабатывает без везения', async () => {
    const { service, deepSeek } = createService();
    jest.spyOn(Math, 'random').mockReturnValue(0.9);
    await (service as any).replyWithSarcasm(makeCtx(), settings({ sarcasmChance: 0.1 }));
    expect(deepSeek.complete).not.toHaveBeenCalled();
  });

  it('replyWithSarcasm отправляет подкол', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.complete.mockResolvedValue('подкол');
    const ctx = makeCtx();
    await (service as any).replyWithSarcasm(ctx, settings({ sarcasmChance: 1 }));
    expect(ctx.reply).toHaveBeenCalled();
    expect(history.insert).toHaveBeenCalled();
  });

  it('replyWithSarcasm молчит при пустом ответе', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, deepSeek } = createService();
    deepSeek.complete.mockResolvedValue('');
    const ctx = makeCtx();
    await (service as any).replyWithSarcasm(ctx, settings({ sarcasmChance: 1 }));
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('TrollService — утилиты', () => {
  it('buildCriminalReply формирует текст с высокой серьёзностью и пояснением', () => {
    const { service } = createService();
    const reply = (service as any).buildCriminalReply(
      {
        probability: 0.9,
        articles: [
          { code: 'ст. 158', title: 'Кража', reason: 'украл' },
          { code: '', title: 'пусто', reason: '' },
        ],
        reason: 'общий',
      },
      0.9,
      settings({ criminalHighThreshold: 0.8 })
    );
    expect(reply).toContain('Почти наверняка');
    expect(reply).toContain('ст. 158');
    expect(reply).not.toContain('Почему:');
  });

  it('buildCriminalReply добавляет общий вывод без пояснений статей', () => {
    const { service } = createService();
    const reply = (service as any).buildCriminalReply(
      { probability: 0.5, articles: [], reason: 'общий' },
      0.5,
      settings({ criminalHighThreshold: 0.8 })
    );
    expect(reply).toContain('Похоже на статью');
    expect(reply).toContain('Почему: общий');
  });

  it('describeMediaKind распознаёт все типы', () => {
    const { service } = createService();
    const cases: Array<[any, string | null]> = [
      [{ photo: [] }, 'картинка'],
      [{ video: {} }, 'видео'],
      [{ animation: {} }, 'гифка'],
      [{ sticker: {} }, 'стикер'],
      [{ voice: {} }, 'голосовое'],
      [{ audio: {} }, 'аудио'],
      [{ video_note: {} }, 'видеосообщение'],
      [{ document: {} }, 'файл'],
      [{ location: {} }, 'геолокация'],
      [{ venue: {} }, 'геолокация'],
      [{ contact: {} }, 'контакт'],
      [{ poll: {} }, 'опрос'],
      [{ dice: {} }, 'кубик'],
      [{}, null],
    ];
    for (const [message, expected] of cases) {
      expect((service as any).describeMediaKind(message)).toBe(expected);
    }
  });

  it('messageHasLink видит url и text_link', () => {
    const { service } = createService();
    expect((service as any).messageHasLink({ entities: [{ type: 'url' }] })).toBe(true);
    expect((service as any).messageHasLink({ caption_entities: [{ type: 'text_link' }] })).toBe(true);
    expect((service as any).messageHasLink({})).toBe(false);
  });

  it('buildHistoryEntry собирает текст, медиа и ссылки', () => {
    const { service } = createService();
    expect((service as any).buildHistoryEntry('привет', null, false, 100)).toBe('привет');
    expect((service as any).buildHistoryEntry('', 'картинка', false, 100)).toBe('[картинка]');
    expect((service as any).buildHistoryEntry('смотри https://x.com', null, true, 100)).toContain(
      '[ссылка]'
    );
    expect((service as any).buildHistoryEntry('ок', null, false, 100)).toBeNull();
  });

  it('isBotMentioned распознаёт @username и text_mention', () => {
    const { service } = createService();
    const ctx = makeCtx();
    expect((service as any).isBotMentioned(ctx, 'эй @trollbot')).toBe(true);
    expect(
      (service as any).isBotMentioned(
        makeCtx({ message: { entities: [{ type: 'text_mention', user: { id: 999 } }] } }),
        null
      )
    ).toBe(true);
    expect((service as any).isBotMentioned(makeCtx({ message: { text: 'нет' } }), 'нет')).toBe(false);
  });

  it('messageText возвращает текст или подпись', () => {
    const { service } = createService();
    expect((service as any).messageText(makeCtx())).toBe('приветствие');
    expect((service as any).messageText(makeCtx({ message: { caption: '  подпись ' } }))).toBe(
      'подпись'
    );
    expect((service as any).messageText(makeCtx({ message: {} }))).toBe('');
    expect((service as any).messageText(makeCtx({ message: undefined }))).toBe('');
  });

  it('safeReply отправляет и возвращает id, переживая ошибку', async () => {
    const { service } = createService();
    const ctx = makeCtx();
    await expect((service as any).safeReply(ctx, 'текст')).resolves.toBe(777);
    expect(ctx.reply).toHaveBeenCalledWith(
      'текст',
      expect.objectContaining({ reply_to_message_id: 10 })
    );
    ctx.reply.mockRejectedValue(new Error('tg'));
    await expect((service as any).safeReply(ctx, 'текст', true)).resolves.toBeNull();
  });

  it('safeSendToChat покрывает все ветки отправки', async () => {
    const { service, bot } = createService();
    await expect((service as any).safeSendToChat(CHAT, 'текст')).resolves.toBe(501);
    await expect((service as any).safeSendToChat(CHAT, 'текст', 5)).resolves.toBe(501);

    bot.api.sendMessage
      .mockRejectedValueOnce(new Error('target gone'))
      .mockResolvedValueOnce({ message_id: 900 });
    await expect((service as any).safeSendToChat(CHAT, 'текст', 5)).resolves.toBe(900);

    bot.api.sendMessage.mockRejectedValue(new Error('gone'));
    await expect((service as any).safeSendToChat(CHAT, 'текст', 5)).resolves.toBeNull();
    await expect((service as any).safeSendToChat(CHAT, 'текст')).resolves.toBeNull();
  });

  it('safeEditMessage глотает ошибку редактирования', async () => {
    const { service } = createService();
    const ctx = makeCtx();
    await (service as any).safeEditMessage(ctx, 'текст');
    expect(ctx.editMessageText).toHaveBeenCalledWith('текст');
    ctx.editMessageText.mockRejectedValue(new Error('edit'));
    await expect((service as any).safeEditMessage(ctx, 'текст')).resolves.toBeUndefined();
  });

  it('remember не сохраняет пустую строку', async () => {
    const { service, history } = createService();
    await (service as any).remember(CHAT, 'user', '   ');
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('remember предупреждает при ошибке вставки', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, history } = createService();
    history.insert.mockRejectedValue(new Error('db'));
    await (service as any).remember(CHAT, 'user', 'текст', { userId: USER, userName: 'Вася' });
    expect(warn).toHaveBeenCalled();
  });

  it('isChatActive отражает флаг записи', async () => {
    const { service, chats } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    await expect((service as any).isChatActive(CHAT)).resolves.toBe(true);
    chats.findOne.mockResolvedValue(null);
    await expect((service as any).isChatActive(CHAT)).resolves.toBe(false);
  });

  it('cleanupHistoryJob и cleanupHistory логируют и глотают ошибки', async () => {
    const { service, history } = createService();
    history.delete.mockResolvedValue({ affected: 3 });
    await (service as any).cleanupHistoryJob();
    expect(history.delete).toHaveBeenCalled();
    history.delete.mockRejectedValue(new Error('db'));
    await expect((service as any).cleanupHistoryJob()).resolves.toBeUndefined();
  });

  it('withinCooldown учитывает ноль и отсутствие записи', () => {
    const { service } = createService();
    expect((service as any).withinCooldown(new Map(), CHAT, 0)).toBe(false);
    expect((service as any).withinCooldown(new Map(), CHAT, 60)).toBe(false);
    expect((service as any).withinCooldown(new Map([[CHAT, Date.now()]]), CHAT, 60)).toBe(true);
  });

  it('trackName и restoreNames возвращают регистр имён', () => {
    const { service } = createService();
    (service as any).trackName(CHAT, USER, 'Вася Пупкин (@vasya)');
    expect((service as any).restoreNames(CHAT, 'вася куда')).toContain('Вася');
    (service as any).trackName(CHAT, null, 'x');
    expect((service as any).restoreNames(999, 'вася')).toBe('вася');
    expect((service as any).restoreNames(CHAT, '')).toBe('');
  });

  it('cleanName нормализует и отбрасывает пустое', () => {
    const { service } = createService();
    expect((service as any).cleanName('Вася\nПупкин')).toBe('Вася Пупкин');
    expect((service as any).cleanName('')).toBeNull();
    expect((service as any).cleanName(undefined)).toBeNull();
  });

  it('describeUser собирает имя и username', () => {
    const { service } = createService();
    expect((service as any).describeUser(undefined)).toBe('Аноним');
    expect((service as any).describeUser({ first_name: 'Вася', id: 1 })).toBe('Вася');
    expect(
      (service as any).describeUser({ first_name: 'Вася', last_name: 'П', username: 'v', id: 1 })
    ).toBe('Вася П (@v)');
  });

  it('describeMessageRefs и tag/pct/logText/cut/escapeHtml работают', () => {
    const { service } = createService();
    expect((service as any).describeMessageRefs(undefined, null)).toBe('');
    expect((service as any).describeMessageRefs(17, 15)).toBe(' [msg 17, replyTo 15]');
    expect((service as any).describeMessageRefs(17, null)).toBe(' [msg 17]');
    expect((service as any).tag(undefined)).toBe('chat=-');
    expect((service as any).tag(CHAT, USER)).toBe(`chat=${CHAT} user=${USER}`);
    expect((service as any).pct(0.5)).toBe('50%');
    expect((service as any).logText('a\nb')).toContain('⏎');
    expect((service as any).logText('x'.repeat(2000), 10)).toContain('…');
    expect((service as any).cut('  много   пробелов  ', 100)).toBe('много пробелов');
    expect((service as any).cut('abcdef', 3)).toBe('abc…');
    expect((service as any).escapeHtml('<a>&')).toBe('&lt;a&gt;&amp;');
    expect((service as any).describeError(new Error('boom'))).toBe('boom');
    expect((service as any).describeError('text')).toBe('text');
  });

  it('finalizePrediction чистит переносы и восстанавливает имена', () => {
    const { service } = createService();
    (service as any).trackName(CHAT, USER, 'Вася');
    const result = (service as any).finalizePrediction(CHAT, 'вася\nпойдёт');
    expect(result).toContain('Вася');
    expect(result).not.toContain('\n');
  });
});

describe('TrollService — дополнительные ветвления', () => {
  it('onMessage обрабатывает подпись вместо текста и сообщение без текста', async () => {
    const { service, history } = createService();
    await (service as any).onMessage(makeCtx({ message: { message_id: 10, caption: 'подпись' } }));
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, role: 'user', content: 'подпись', messageId: 10 })
    );

    history.insert.mockClear();
    await (service as any).onMessage(makeCtx({ message: { message_id: 10 } }));
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('onMessage распознаёт реплай боту и игнорирует реплай другому', async () => {
    const { service, settingsSvc, deepSeek } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 0 });
    deepSeek.complete.mockResolvedValue('ответ');
    const toBot = makeCtx({
      message: {
        message_id: 10,
        text: 'ответь мне пожалуйста',
        reply_to_message: { from: { id: 999 }, message_id: 9 },
      },
    });
    await (service as any).onMessage(toBot);
    await flush();
    expect(toBot.reply).toHaveBeenCalled();

    const other = makeCtx({
      message: {
        message_id: 11,
        text: 'ответь мне пожалуйста',
        reply_to_message: { from: { id: 5 }, message_id: 9 },
      },
    });
    await (service as any).onMessage(other);
  });

  it('onMessage учитывает медиа и ссылку при сборке записи', async () => {
    const { service, history } = createService();
    await (service as any).onMessage(
      makeCtx({ message: { message_id: 10, caption: 'смотри https://x.com', photo: [] } })
    );
    const photoEntry = history.insert.mock.calls[0][0].content;
    expect(photoEntry).toContain('[картинка]');
    expect(photoEntry).toContain('[ссылка]');
    expect(photoEntry).not.toContain('x.com');

    history.insert.mockClear();
    await (service as any).onMessage(
      makeCtx({ message: { message_id: 11, text: 'ссылка https://example.com тут' } })
    );
    const linkEntry = history.insert.mock.calls[0][0].content;
    expect(linkEntry).toContain('[ссылка]');
    expect(linkEntry).not.toContain('example.com');
  });

  it('onMessage отвечает списком команд даже при сбое отправки', async () => {
    const { service, history } = createService();
    const ctx = makeCtx({ message: { message_id: 10, text: 'что ты умеешь' } });
    ctx.reply.mockRejectedValue(new Error('tg'));
    await expect((service as any).onMessage(ctx)).resolves.toBeUndefined();
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: TROLL_CAPABILITIES_REPLY })
    );
  });

  it('checkCriminalArticle выходит на пустом после очистки вводе', async () => {
    const { service, deepSeek } = createService();
    await (service as any).checkCriminalArticle(
      makeCtx(),
      '\u200b\u200b\u200b',
      settings({ maxInputChars: 100 })
    );
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('checkCriminalArticle работает без статей и без message', async () => {
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue({ probability: 0.9 });
    const ctx = makeCtx({ message: undefined });
    await (service as any).checkCriminalArticle(ctx, 'состав', settings());
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('checkCriminalArticle переживает сбой отправки', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.completeJson.mockResolvedValue({ probability: 0.9, articles: [], reason: 'r' });
    const ctx = makeCtx({ message: undefined });
    ctx.reply.mockRejectedValue(new Error('tg'));
    await expect(
      (service as any).checkCriminalArticle(ctx, 'состав', settings())
    ).resolves.toBeUndefined();
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant' })
    );
    expect((service as any).analyzingChats.has(CHAT)).toBe(false);
  });

  it('onMessage запускает проверку УК без message', async () => {
    const { service, settingsSvc, deepSeek } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    deepSeek.completeJson.mockResolvedValue({ probability: 0.9, articles: [] });
    await (service as any).onMessage(makeCtx({ message: { message_id: 30, text: 'текст' } }));
    await flush();
    expect(deepSeek.completeJson).toHaveBeenCalled();
  });

  it('enqueueJerk работает с пустым содержимым и без автора', () => {
    jest.useFakeTimers();
    const { service, settingsSvc } = createService();
    settingsSvc.current = settings({ jerkEnabled: true, jerkBatchWindowSec: 10 });
    const ctx: any = { chat: { id: CHAT } };
    (service as any).enqueueJerk(ctx, null, settingsSvc.current);
    const batch = (service as any).jerkBatches.get(CHAT);
    expect(batch.texts).toEqual(['(без текста)']);
    (service as any).enqueueJerk(ctx, null, settingsSvc.current);
    expect((service as any).jerkBatches.get(CHAT).texts.length).toBe(2);
  });

  it('scheduleJerkFlush по таймеру запускает flushJerk', () => {
    jest.useFakeTimers();
    const { service } = createService();
    const flushSpy = jest.spyOn(service as any, 'flushJerk').mockResolvedValue(undefined);
    (service as any).scheduleJerkFlush(CHAT, 1);
    expect(flushSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1100);
    expect(flushSpy).toHaveBeenCalledWith(CHAT, 1);
    jest.useRealTimers();
  });

  it('startTyping переживает таймер без unref', () => {
    jest.useFakeTimers();
    const { service, bot } = createService();
    const spy = jest.spyOn(global, 'setInterval').mockReturnValue(1 as any);
    const interval = (service as any).startTyping(CHAT);
    expect(interval).toBe(1);
    expect(bot.api.sendChatAction).toHaveBeenCalledWith(CHAT, 'typing');
    spy.mockRestore();
  });

  it('flushJerk переживает сбой отправки', async () => {
    const { service, chats, deepSeek, bot } = createService();
    chats.findOne.mockResolvedValue({ isActive: true });
    (service as any).jerkBatches.set(CHAT, {
      texts: ['a'],
      users: new Set(['Вася']),
      timer: 1,
      typingTimer: 2,
    });
    deepSeek.complete.mockResolvedValue('дерзи');
    bot.api.sendMessage.mockRejectedValue(new Error('gone'));
    await (service as any).flushJerk(CHAT, 10);
    expect((service as any).lastJerkAnswerAt.get(CHAT)).toBeDefined();
  });

  it('maybeReact без сообщения ничего не делает', async () => {
    const { service, bot } = createService();
    (service as any).lastReactionEmoji.clear();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    (service as any).maybeReact(
      makeCtx({ message: undefined }),
      settings({ reactionEnabled: true, reactionChance: 1 })
    );
    await flush();
    expect(bot.api.setMessageReaction).not.toHaveBeenCalled();
    expect((service as any).lastReactionAt.has(CHAT)).toBe(false);
  });
});

describe('TrollService — ветвления команд', () => {
  it('onStat считает годы из статей без number и без message', async () => {
    const { service, chats, history, deepSeek, bot, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeJson.mockResolvedValue({
      articles: [
        { code: 'ст. 1', title: '', years: 0, reason: '' },
        { code: 'ст. 2', title: 'Т', reason: 'П' },
      ],
    });
    const ctx = makeCtx({ from: { id: USER, is_bot: false, first_name: '' }, message: undefined });
    await (service as any).onStatCommand(ctx);
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it('onStat использует zero years, если их нет в корне', async () => {
    const { service, chats, history, deepSeek, bot, settingsSvc } = createService();
    settingsSvc.current = settings({ criminalEnabled: true });
    chats.findOne.mockResolvedValue({ isActive: true });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeJson.mockResolvedValue({ articles: null });
    const ctx = makeCtx({ message: undefined });
    await (service as any).onStatCommand(ctx);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('0 лет — пока чисто');
  });

  it('onFuture отдаёт кэш без поля requests и без message', async () => {
    const { service, chats, predictions, settingsSvc } = createService();
    settingsSvc.current = settings();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue({ id: 1, text: 'кэш' });
    const ctx = makeCtx({ message: undefined });
    await (service as any).onFutureCommand(ctx);
    expect(predictions.update).toHaveBeenCalledWith({ id: 1 }, { requests: 2 });
  });

  it('onFuture гадает обидное без message', async () => {
    const { service, chats, predictions, deepSeek, settingsSvc } = createService();
    settingsSvc.current = settings();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue({ id: 1, text: 'кэш', requests: 2 });
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue('обидное');
    const ctx = makeCtx({ message: undefined });
    await (service as any).onFutureCommand(ctx);
    expect(predictions.update).toHaveBeenCalled();
  });

  it('onFuture создаёт новое предсказание без message', async () => {
    const { service, chats, predictions, deepSeek, settingsSvc } = createService();
    settingsSvc.current = settings();
    chats.findOne.mockResolvedValue({ isActive: true });
    predictions.findOne.mockResolvedValue(null);
    predictions.find.mockResolvedValue([]);
    deepSeek.completeText.mockResolvedValue('плохое');
    const ctx = makeCtx({ message: undefined });
    await (service as any).onFutureCommand(ctx);
    expect(predictions.insert).toHaveBeenCalled();
  });

  it('denyRudely отправляет текст модели, в том числе без message', async () => {
    const { service, deepSeek, bot } = createService();
    deepSeek.completeText.mockResolvedValue('иди отсюда');
    await (service as any).denyRudely(makeCtx({ message: undefined }), 'причина');
    expect(bot.api.sendMessage).toHaveBeenCalledWith(CHAT, 'иди отсюда', expect.any(Object));
  });
});

describe('TrollService — ветвления сумм, зеркал и отчётов', () => {
  it('onSummary работает без строки чата и со старой меткой', async () => {
    const { service, chats, history, deepSeek, settingsSvc } = createService();
    settingsSvc.current = settings();
    chats.findOne
      .mockResolvedValueOnce({ isActive: true })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ isActive: true })
      .mockResolvedValueOnce({ lastSummaryAt: new Date(Date.now() - 99999999) });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.completeText.mockResolvedValue('саммари');
    const ctx = makeCtx({ message: undefined });
    await (service as any).onSummaryCommand(ctx);
    await (service as any).onSummaryCommand(ctx);
    expect(deepSeek.completeText).toHaveBeenCalled();
  });

  it('pickMirrorWord не падает на тексте без кириллицы', () => {
    const { service } = createService();
    expect((service as any).pickMirrorWord(CHAT, '12345 abcdef', settings({ mirrorChance: 1 }))).toBeNull();
  });

  it('generateMirror работает без автора и при пустом ответе', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.completeText.mockResolvedValue(null);
    const ctx = makeCtx({ from: undefined, message: undefined });
    await (service as any).generateMirror(ctx, 'привет', settings({ maxInputChars: 100 }));
    expect(deepSeek.completeText).toHaveBeenCalledWith(
      MIRROR_PROMPT,
      expect.any(String),
      expect.objectContaining({ label: 'кривляние' })
    );
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('generateMirror переживает сбой отправки', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.completeText.mockResolvedValue('хуйвет');
    const ctx = makeCtx({ from: undefined, message: undefined });
    ctx.reply.mockRejectedValue(new Error('tg'));
    await expect(
      (service as any).generateMirror(ctx, 'привет', settings({ maxInputChars: 100 }))
    ).resolves.toBeUndefined();
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'хуйвет' })
    );
  });

  it('replyWithSarcasm работает без автора и переживает сбой отправки', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.complete.mockResolvedValue('подкол');
    const ctx = makeCtx({ from: undefined, message: undefined });
    await (service as any).replyWithSarcasm(ctx, settings({ sarcasmChance: 1 }));
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'подкол' })
    );

    history.insert.mockClear();
    ctx.reply.mockRejectedValue(new Error('tg'));
    await expect(
      (service as any).replyWithSarcasm(ctx, settings({ sarcasmChance: 1 }))
    ).resolves.toBeUndefined();
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'подкол' })
    );
  });

  it('replyAsJerk работает без автора и переживает сбой отправки', async () => {
    const { service, deepSeek, history } = createService();
    deepSeek.complete.mockResolvedValue('дерзи');
    const ctx = makeCtx({ from: undefined, message: undefined });
    await (service as any).replyAsJerk(ctx);
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'дерзи' })
    );

    history.insert.mockClear();
    ctx.reply.mockRejectedValue(new Error('tg'));
    await expect((service as any).replyAsJerk(ctx)).resolves.toBeUndefined();
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'дерзи' })
    );
  });

  it('buildCriminalReply переживает articles не-массив и пустой код', () => {
    const { service } = createService();
    const noArticles = (service as any).buildCriminalReply(
      { probability: 0.5, articles: null, reason: 'общий' },
      0.5,
      settings()
    );
    expect(noArticles).toContain('Почему: общий');

    const emptyCode = (service as any).buildCriminalReply(
      { probability: 0.5, articles: [{ code: '!!!', title: 'Т', reason: 'П' }], reason: '' },
      0.5,
      settings()
    );
    expect(emptyCode).not.toContain('•');
  });

  it('buildCriminalReply покрывает пустые title и reason статьи', () => {
    const { service } = createService();
    const reply = (service as any).buildCriminalReply(
      { probability: 0.5, articles: [{ code: 'ст. 1', title: '', reason: '' }], reason: 'общий' },
      0.5,
      settings()
    );
    expect(reply).toContain('Почему: общий');
  });

  it('onMyChatMember работает без названия чата', async () => {
    const { service, chats } = createService();
    await (service as any).onMyChatMember({
      myChatMember: {
        chat: { id: CHAT, type: 'supergroup' },
        new_chat_member: { status: 'member' },
        old_chat_member: { status: 'left' },
        from: { id: 5, first_name: 'Петя' },
      },
    });
    expect(chats.upsert).toHaveBeenCalled();
  });

  it('onOwnerDecision переживает нажатие без from', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = createService();
    const ctx = makeCtx({ from: undefined, match: ['troll:approve:1', 'approve', '1'] });
    await (service as any).onOwnerDecision(ctx);
    expect(warn).toHaveBeenCalled();
  });

  it('onPrivateMessage отклоняет дефект без исходного чата', async () => {
    const { service, chats, history, bot } = createService();
    chats.find.mockResolvedValue([{ chatId: CHAT, isActive: true }]);
    history.find.mockResolvedValue([
      historyRow({ role: 'assistant', content: 'ответ бота', userName: 'бот' }),
    ]);
    chats.findOne.mockResolvedValue(null);
    const ctx = makeCtx({
      chat: { id: 5, type: 'private' },
      from: { id: OWNER },
      message: { message_id: 1, text: 'ответ бота' },
    });
    await (service as any).onPrivateMessage(ctx);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      5,
      expect.stringContaining('тролль там выключен'),
      expect.any(Object)
    );
  });

  it('onPrivateMessage принимает нормализованное совпадение и пустые поля', async () => {
    const { service, chats, history, deepSeek, defects, bot } = createService();
    chats.find.mockResolvedValue([{ chatId: CHAT, isActive: true }]);
    history.find.mockResolvedValue([
      historyRow({
        role: 'assistant',
        content: 'Ответ бота.',
        userName: 'бот',
        id: 3,
        messageId: null,
        replyToMessageId: null,
      }),
    ]);
    chats.findOne.mockResolvedValue({ chatId: CHAT, isActive: true, title: null });
    history.findOne.mockResolvedValue(null);
    deepSeek.completeJson.mockResolvedValue(null);
    defects.create.mockImplementation((v: any) => ({ ...v, id: 7 }));
    defects.save.mockImplementation(async (v: any) => v);
    const ctx = makeCtx({
      chat: { id: 5, type: 'private' },
      from: { id: OWNER },
      message: { message_id: 1, text: 'ответ бота' },
    });
    await (service as any).onPrivateMessage(ctx);
    expect(defects.save).toHaveBeenCalled();
  });

  it('diagnoseDefect отбрасывает битую серьёзность и поля', async () => {
    const { service, deepSeek } = createService();
    deepSeek.completeJson.mockResolvedValue({
      severity: 'bogus',
      summary: null,
      problems: 'нет',
      fixSuggestions: 'нет',
    });
    const result = await (service as any).diagnoseDefect({
      answer: 'a',
      replyTo: historyRow({ userName: null, userId: null, content: 'вопрос' }),
      context: 'ctx',
      sourceChatTitle: null,
    });
    expect(result.severity).toBe('unknown');
    expect(result.problems).toEqual([]);
    expect(result.fixes).toEqual([]);
  });

  it('formatDefectReport покрывает отсутствие имени реплайщика', () => {
    const { service } = createService();
    const report = (service as any).formatDefectReport(
      { id: 1, sourceChatId: CHAT, sourceChatTitle: 'Чат' },
      historyRow({ role: 'assistant', content: 'ответ бота' }),
      historyRow({ userName: null, userId: null, content: 'реплика' }),
      { severity: 'low', summary: '', problems: [], fixes: [] }
    );
    expect(report).toContain('участник');
    expect(report).toContain('?');
  });

  it('cut переживает null-текст', () => {
    const { service } = createService();
    expect((service as any).cut(null, 5)).toBe('');
  });

  it('isBotMentioned переживает отсутствие message и user', () => {
    const { service } = createService();
    expect((service as any).isBotMentioned(makeCtx({ message: undefined }), null)).toBe(false);
    expect(
      (service as any).isBotMentioned(
        makeCtx({ message: { entities: [{ type: 'text_mention' }] } }),
        null
      )
    ).toBe(false);
  });

  it('buildConversationParts обрабатывает focus с null userId', async () => {
    const { service, history } = createService();
    history.find.mockResolvedValue([historyRow()]);
    const parts = await (service as any).buildConversationParts(CHAT, {
      userName: 'Вася',
      userId: null,
    });
    expect(parts.directive).toContain('Вася');
  });

  it('generateCheckedReply переживает null от модели и пустые замечания', async () => {
    const { service, deepSeek, history, settingsSvc } = createService();
    settingsSvc.current = settings({ selfCheckEnabled: true, selfCheckThreshold: 0.5 });
    history.find.mockResolvedValue([historyRow()]);
    deepSeek.complete.mockResolvedValue(null);
    deepSeek.completeJson.mockResolvedValue({ score: 0, issues: [] });
    const result = await (service as any).generateCheckedReply(
      JERK_PROMPT,
      CHAT,
      { label: 'тест' },
      undefined,
      (raw: string) => raw || 'fallback'
    );
    expect(result).toBe('fallback');
  });

  it('remember без meta и с пустыми полями', async () => {
    const { service, history } = createService();
    await (service as any).remember(CHAT, 'user', 'текст');
    await (service as any).remember(CHAT, 'assistant', 'ответ', {});
    expect(history.insert).toHaveBeenCalledTimes(2);
  });

  it('safeReply без message, чата и автора', async () => {
    const { service } = createService();
    const ctx = makeCtx({ message: undefined, chat: undefined, from: undefined });
    await expect((service as any).safeReply(ctx, 'текст')).resolves.toBe(777);
  });

  it('describeUser без имени даёт Анонима', () => {
    const { service } = createService();
    expect((service as any).describeUser({ id: 1 })).toBe('Аноним');
  });

  it('threadName очищает имя, restoreNames переживает пустую карту', () => {
    const { service } = createService();
    (service as any).trackName(CHAT, USER, 'Вася (@vasya)');
    expect((service as any).restoreNames(CHAT, 'вася пошёл')).toContain('Вася');
    expect((service as any).restoreNames(123, 'вася')).toBe('вася');
  });
});













