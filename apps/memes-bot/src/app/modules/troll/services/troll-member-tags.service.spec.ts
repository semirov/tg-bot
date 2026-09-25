jest.mock('./deepseek.service', () => ({ DeepSeekService: class DeepSeekService {} }));

import { TrollMemberTagsService } from './troll-member-tags.service';
import {
  TROLL_MEMBER_TAG_BATCH_MESSAGES,
  TROLL_MEMBER_TAG_COOLDOWN_HOURS,
  TROLL_MEMBER_TAG_TRANSCRIPT_CHARS,
} from '../constants/troll-limits';

const CHAT = -100500;
const USER = 42;

function userRows(
  userId: number,
  count: number,
  options: { userName?: string | null; newestId?: number; content?: (index: number) => string } = {}
): any[] {
  const newestId = options.newestId ?? count;
  return Array.from({ length: count }, (_, index) => ({
    id: newestId - index,
    chatId: CHAT,
    role: 'user',
    content: (options.content ?? (() => 'реплика'))(index),
    userId,
    userName: 'userName' in options ? options.userName : 'Вася',
    messageId: 1000 - index,
    replyToMessageId: null,
    createdAt: new Date(),
  }));
}

function storedTag(over: any = {}): any {
  return {
    id: 5,
    chatId: CHAT,
    userId: USER,
    userName: 'Вася',
    tag: 'старый-тег',
    reason: 'было',
    topics: null,
    lastMessageId: 0,
    lastEvaluatedAt: null,
    updatedAt: new Date(),
    ...over,
  };
}

function setup(
  options: {
    rows?: unknown[];
    count?: number;
    stored?: unknown;
    chatTags?: unknown[];
    suggestion?: unknown;
    enabled?: boolean;
    tagsEnabled?: boolean;
    botInfo?: unknown;
    member?: unknown;
    admins?: unknown;
    announcement?: string | null;
  } = {}
) {
  const bot = {
    botInfo: options.botInfo === undefined ? { id: 999 } : options.botInfo,
    api: {
      getChatMember: jest
        .fn()
        .mockResolvedValue(
          options.member === undefined
            ? { status: 'administrator', can_manage_tags: true }
            : options.member
        ),
      getChatAdministrators: jest.fn().mockResolvedValue(options.admins ?? []),
      setChatMemberTag: jest.fn().mockResolvedValue(true),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
    },
  };
  const deepSeek = {
    completeJson: jest.fn().mockResolvedValue(
      options.suggestion === undefined
        ? {
            topics: ['кальян', 'мтс'],
            tags: [{ tag: 'подмыхан', reason: 'дымит как паровоз', relevance: 0.9 }],
          }
        : options.suggestion
    ),
    completeText: jest
      .fn()
      .mockResolvedValue(
        options.announcement === undefined
          ? 'нарекаю вася - подмыхан, дымит как паровоз, хули'
          : options.announcement
      ),
  };
  const settings = {
    current: { enabled: options.enabled ?? true, memberTagsEnabled: options.tagsEnabled ?? true },
  };
  const history = {
    count: jest.fn().mockResolvedValue(options.count ?? TROLL_MEMBER_TAG_BATCH_MESSAGES),
    find: jest
      .fn()
      .mockResolvedValue(options.rows ?? userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES)),
  };
  const tags = {
    findOne: jest.fn().mockResolvedValue(options.stored ?? null),
    find: jest.fn().mockResolvedValue(options.chatTags ?? []),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const service = new TrollMemberTagsService(
    bot as never,
    deepSeek as never,
    settings as never,
    history as never,
    tags as never
  );

  return { service, bot, deepSeek, settings, history, tags };
}

const oldEval = new Date(Date.now() - (TROLL_MEMBER_TAG_COOLDOWN_HOURS + 1) * 3600 * 1000);

describe('TrollMemberTagsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('выключенный тролль или теги — ничего не делает', async () => {
    const off = setup({ enabled: false });
    await off.service.onUserMessage(CHAT, USER);
    expect(off.history.count).not.toHaveBeenCalled();

    const noTags = setup({ tagsEnabled: false });
    await noTags.service.onUserMessage(CHAT, USER);
    expect(noTags.history.count).not.toHaveBeenCalled();
  });

  it('бот без права, не админ или без botInfo — пропуск', async () => {
    const member = setup({ member: { status: 'member' } });
    await member.service.onUserMessage(CHAT, USER);
    expect(member.history.count).not.toHaveBeenCalled();

    const noRight = setup({ member: { status: 'administrator', can_manage_tags: false } });
    await noRight.service.onUserMessage(CHAT, USER);
    expect(noRight.history.count).not.toHaveBeenCalled();

    const noBot = setup({ botInfo: null });
    await noBot.service.onUserMessage(CHAT, USER);
    expect(noBot.history.count).not.toHaveBeenCalled();
  });

  it('ошибка проверки прав логируется и не роняет', async () => {
    const { service, bot } = setup();
    bot.api.getChatMember.mockRejectedValue(new Error('tg'));
    const debug = jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    await expect(service.onUserMessage(CHAT, USER)).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('не проверить права'));
  });

  it('создателя чата пропускаем', async () => {
    const { service, history } = setup({ admins: [{ status: 'creator', user: { id: USER } }] });
    await service.onUserMessage(CHAT, USER);
    expect(history.count).not.toHaveBeenCalled();
  });

  it('создатель со строковым userId тоже пропускается', async () => {
    const { service, history } = setup({ admins: [{ status: 'creator', user: { id: USER } }] });
    await service.onUserMessage(CHAT, String(USER) as never);
    expect(history.count).not.toHaveBeenCalled();
  });

  it('ошибка получения админов не мешает обработке', async () => {
    const { service, bot, tags } = setup();
    bot.api.getChatAdministrators.mockRejectedValue(new Error('tg'));
    const debug = jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    await service.onUserMessage(CHAT, USER);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('не определить создателя'));
    expect(tags.save).toHaveBeenCalled();
  });

  it('права кэшируются и не дёргаются каждый раз', async () => {
    const { service, bot } = setup();
    await service.onUserMessage(CHAT, USER);
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.getChatMember).toHaveBeenCalledTimes(1);
  });

  it('нечисловой userId — пропуск', async () => {
    const { service, history } = setup();
    await service.onUserMessage(CHAT, 'abc' as never);
    expect(history.count).not.toHaveBeenCalled();
  });

  it('пустая выборка свежих реплик — пропуск', async () => {
    const { service, deepSeek, tags } = setup({ rows: [] });
    await service.onUserMessage(CHAT, USER);
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('меньше 10 сообщений — анализа нет', async () => {
    const { service, history, deepSeek } = setup({ count: TROLL_MEMBER_TAG_BATCH_MESSAGES - 1 });
    await service.onUserMessage(CHAT, USER);
    expect(history.find).not.toHaveBeenCalled();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('меньше десятка реплик — анализа нет', async () => {
    const { service, history } = setup({ count: TROLL_MEMBER_TAG_BATCH_MESSAGES - 1 });
    await service.onUserMessage(CHAT, USER);
    expect(history.find).not.toHaveBeenCalled();
  });

  it('троттл: не долбит модель повторной попыткой', async () => {
    const { service, history } = setup({ suggestion: null });
    await service.onUserMessage(CHAT, USER);
    const calls = history.find.mock.calls.length;
    await service.onUserMessage(CHAT, USER);
    expect(history.find.mock.calls.length).toBe(calls);
  });

  it('при накоплении больше десятка анализ всё равно идёт', async () => {
    const { service, history } = setup({ count: TROLL_MEMBER_TAG_BATCH_MESSAGES + 5 });
    await service.onUserMessage(CHAT, USER);
    expect(history.find).toHaveBeenCalled();
  });

  it('на 10-м сообщении нарекает, объявляет и сохраняет курсор', async () => {
    const { service, bot, tags, deepSeek } = setup();

    await service.onUserMessage(CHAT, USER);

    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'подмыхан');
    const [chatId, text, opts] = bot.api.sendMessage.mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(text).toBe('нарекаю Вася - подмыхан, дымит как паровоз, хули');
    expect(opts).toMatchObject({ reply_to_message_id: 1000 });
    expect(tags.save).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT,
        userId: USER,
        tag: 'подмыхан',
        lastMessageId: TROLL_MEMBER_TAG_BATCH_MESSAGES,
        lastEvaluatedAt: expect.any(Date),
      })
    );
    expect(deepSeek.completeText).toHaveBeenCalledWith(
      expect.stringContaining('нарекаю'),
      expect.stringContaining('подмыхан'),
      expect.objectContaining({ label: 'наречение' })
    );
  });

  it('на 20-м сообщении тоже анализирует', async () => {
    const { service, bot } = setup({ count: 20, rows: userRows(USER, 20, { newestId: 100 }) });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).toHaveBeenCalled();
  });

  it('кулдаун на человека: свежая оценка — пропуск', async () => {
    const { service, bot } = setup({ stored: storedTag({ lastEvaluatedAt: new Date() }) });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
  });

  it('после суток сменяем тег и обновляем запись', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES, { newestId: 100 });
    const { service, bot, tags } = setup({
      rows,
      stored: storedTag({ lastMessageId: 90, lastEvaluatedAt: oldEval }),
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'подмыхан');
    expect(tags.save).toHaveBeenCalledWith(expect.objectContaining({ id: 5, lastMessageId: 100 }));
  });

  it('строковый lastMessageId не мешает кулдауну', async () => {
    const { service, bot } = setup({
      stored: storedTag({ lastMessageId: '90', lastEvaluatedAt: new Date() }),
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
  });

  it('тот же тег: не применяем, но двигаем курсор', async () => {
    const { service, bot, tags } = setup({
      stored: storedTag({ tag: 'подмыхан', lastMessageId: 90, lastEvaluatedAt: oldEval }),
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(tags.update).toHaveBeenCalledWith(
      { id: 5 },
      expect.objectContaining({ lastEvaluatedAt: expect.any(Date) })
    );
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('пустой ответ модели курсор не двигает', async () => {
    const { service, tags } = setup({ suggestion: null });
    await service.onUserMessage(CHAT, USER);
    expect(tags.save).not.toHaveBeenCalled();
    expect(tags.update).not.toHaveBeenCalled();
  });

  it('пустые реплики — модель не вызывается', async () => {
    const { service, deepSeek } = setup({
      rows: userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES, { content: () => '   ' }),
    });
    await service.onUserMessage(CHAT, USER);
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('оскорбительные теги отсеиваются, берём безобидный', async () => {
    const { service, bot } = setup({
      suggestion: {
        tags: [
          { tag: 'хуеглот', reason: 'x', relevance: 1 },
          { tag: 'докер-обжора', reason: 'y', relevance: 0.5 },
        ],
      },
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'докер-обжора');
  });

  it('если все теги оскорбительные — не нарекаем', async () => {
    const { service, bot, tags } = setup({
      suggestion: { tags: [{ tag: 'долбоёб', reason: 'x', relevance: 1 }] },
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('выбирает кандидата с максимальным скором и санитайзит тег', async () => {
    const { service, bot } = setup({
      suggestion: {
        tags: [
          { tag: 'мтс-страдалец', reason: 'плачет', relevance: 0.4 },
          { tag: 'кальянный🔥лорд', reason: 'дым', relevance: 0.8 },
        ],
      },
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'кальянный лорд');
  });

  it('передаёт занятые теги других участников', async () => {
    const other = 555;
    const { service, deepSeek } = setup({
      chatTags: [storedTag({ id: 7, userId: other, tag: 'пробив-мастер' })],
    });
    await service.onUserMessage(CHAT, USER);
    const system = deepSeek.completeJson.mock.calls[0][0] as string;
    expect(system).toContain('Уже занятые теги');
    expect(system).toContain('пробив-мастер');
    expect(system).toContain('Не повторяй');
  });

  it('строковый userId занятого тега сравнивается корректно', async () => {
    const { service, deepSeek } = setup({
      chatTags: [storedTag({ id: 7, userId: String(USER), tag: 'свой-тег' })],
    });
    await service.onUserMessage(CHAT, USER);
    const system = deepSeek.completeJson.mock.calls[0][0] as string;
    expect(system).not.toContain('Уже занятые теги');
  });

  it('расшифровка не превышает лимит', async () => {
    const { service, deepSeek } = setup({
      rows: userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES, { content: () => 'x'.repeat(600) }),
      count: TROLL_MEMBER_TAG_BATCH_MESSAGES,
    });
    await service.onUserMessage(CHAT, USER);
    const payload = deepSeek.completeJson.mock.calls[0][1] as string;
    expect(payload.length).toBeLessThanOrEqual(TROLL_MEMBER_TAG_TRANSCRIPT_CHARS + 64);
    expect(payload).toContain('<user_message>');
  });

  it('без ответа модели объявление падает в шаблон с именем', async () => {
    const { service, bot } = setup({
      rows: userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES, { userName: null }),
      announcement: null,
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('нарекаю Участник');
  });

  it('без messageId объявление уходит без ответа', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES).map((row) => ({
      ...row,
      messageId: null,
    }));
    const { service, bot } = setup({ rows });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.sendMessage.mock.calls[0][2]).not.toHaveProperty('reply_to_message_id');
  });

  it('ошибка объявления логируется, тег сохраняется', async () => {
    const { service, bot, tags } = setup();
    bot.api.sendMessage.mockRejectedValue(new Error('tg'));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await service.onUserMessage(CHAT, USER);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('объявление'));
    expect(tags.save).toHaveBeenCalled();
  });

  it('ошибка setChatMemberTag пробрасывается наверх (обработает вызывающий)', async () => {
    const { service, bot, tags } = setup();
    bot.api.setChatMemberTag.mockRejectedValue(new Error('no rights'));
    await expect(service.onUserMessage(CHAT, USER)).rejects.toThrow('no rights');
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('null-контент и нечисловой relevance не ломают отбор', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES);
    rows[0].content = null;
    const { service, bot } = setup({
      rows,
      suggestion: {
        tags: [
          null,
          { tag: 'подмыхан', reason: null, relevance: 'abc' },
          { tag: 'кальян', reason: 'дым', relevance: 0.9 },
        ],
      },
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'кальян');
  });

  it('реплика без id — курсор сохраняется null', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES).map((row) => ({ ...row, id: 0 }));
    const { service, tags } = setup({ rows });
    await service.onUserMessage(CHAT, USER);
    expect(tags.save).toHaveBeenCalledWith(expect.objectContaining({ lastMessageId: null }));
  });

  it('тот же тег без новых id — курсор остаётся прежним', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_BATCH_MESSAGES).map((row) => ({ ...row, id: 0 }));
    const { service, tags } = setup({
      rows,
      stored: storedTag({ tag: 'подмыхан', lastMessageId: 77, lastEvaluatedAt: oldEval }),
    });
    await service.onUserMessage(CHAT, USER);
    expect(tags.update).toHaveBeenCalledWith(
      { id: 5 },
      expect.objectContaining({ lastMessageId: 77 })
    );
  });

  it('без reason и ответа модели — шаблон с «ты сам всё понимаешь»', async () => {
    const { service, bot } = setup({
      suggestion: { tags: [{ tag: 'подмыхан', relevance: 1 }] },
      announcement: null,
    });
    await service.onUserMessage(CHAT, USER);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('ты сам всё понимаешь');
  });

  it('не-Error при проверке прав логируется строкой', async () => {
    const { service, bot } = setup();
    bot.api.getChatMember.mockRejectedValue('oops');
    const debug = jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    await service.onUserMessage(CHAT, USER);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('oops'));
  });

  it('без topics сохраняет null', async () => {
    const { service, tags } = setup({
      suggestion: { tags: [{ tag: 'подмыхан', relevance: 1 }] },
    });
    await service.onUserMessage(CHAT, USER);
    expect(tags.save).toHaveBeenCalledWith(expect.objectContaining({ topics: null }));
  });
});
