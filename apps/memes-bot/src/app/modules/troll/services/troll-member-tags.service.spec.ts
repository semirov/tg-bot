jest.mock('./deepseek.service', () => ({ DeepSeekService: class DeepSeekService {} }));

import { TrollMemberTagsService } from './troll-member-tags.service';
import {
  TROLL_MEMBER_TAG_COOLDOWN_HOURS,
  TROLL_MEMBER_TAG_MIN_MESSAGES,
  TROLL_MEMBER_TAG_NEW_MESSAGES,
  TROLL_MEMBER_TAG_TRANSCRIPT_CHARS,
} from '../constants/troll-limits';

const CHAT = -100500;
const USER = 42;

/** Реплики участника: order — «от новых к старым», id убывают. */
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
    lastMessageId: null,
    lastEvaluatedAt: null,
    updatedAt: new Date(),
    ...over,
  };
}

function setup(
  options: {
    rows?: unknown[];
    stored?: unknown[];
    suggestion?: unknown;
    enabled?: boolean;
    tagsEnabled?: boolean;
    botInfo?: unknown;
    member?: unknown;
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
      getChatAdministrators: jest.fn().mockResolvedValue([]),
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
  const chats = { find: jest.fn().mockResolvedValue([{ chatId: CHAT }]) };
  const history = {
    find: jest.fn().mockResolvedValue(options.rows ?? userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES)),
  };
  const tags = {
    find: jest.fn().mockResolvedValue(options.stored ?? []),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const service = new TrollMemberTagsService(
    bot as never,
    deepSeek as never,
    settings as never,
    chats as never,
    history as never,
    tags as never
  );

  return { service, bot, deepSeek, settings, chats, history, tags };
}

describe('TrollMemberTagsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('cron-джоба дёргает обход', async () => {
    const { service } = setup();
    const spy = jest.spyOn(service, 'refreshMemberTags').mockResolvedValue(undefined);
    await service.refreshMemberTagsJob();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('выключенный тролль или теги — ничего не делает', async () => {
    const off = setup({ enabled: false });
    await off.service.refreshMemberTags();
    expect(off.chats.find).not.toHaveBeenCalled();

    const noTags = setup({ tagsEnabled: false });
    await noTags.service.refreshMemberTags();
    expect(noTags.chats.find).not.toHaveBeenCalled();
  });

  it('ошибка выборки чатов логируется и не пробрасывается', async () => {
    const { service, chats } = setup();
    chats.find.mockRejectedValue(new Error('db down'));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await expect(service.refreshMemberTags()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('сбой внутри чата логируется и не роняет обход', async () => {
    const { service, history } = setup();
    history.find.mockRejectedValue(new Error('history down'));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await expect(service.refreshMemberTags()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('history down'));
  });

  it('пустая история чата — ничего не делаем', async () => {
    const { service, deepSeek } = setup({ rows: [] });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('бот не админ/без права или без botInfo — чат пропускается', async () => {
    const member = setup({ member: { status: 'member' } });
    await member.service.refreshMemberTags();
    expect(member.history.find).not.toHaveBeenCalled();

    const noRight = setup({ member: { status: 'administrator', can_manage_tags: false } });
    await noRight.service.refreshMemberTags();
    expect(noRight.history.find).not.toHaveBeenCalled();

    const noBot = setup({ botInfo: null });
    await noBot.service.refreshMemberTags();
    expect(noBot.history.find).not.toHaveBeenCalled();
  });

  it('создателя чата не нарекаем — Telegram запрещает', async () => {
    const { service, bot } = setup();
    bot.api.getChatAdministrators.mockResolvedValue([{ status: 'creator', user: { id: USER } }]);
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
  });

  it('ошибка определения создателя не мешает наречению', async () => {
    const { service, bot } = setup();
    bot.api.getChatAdministrators.mockRejectedValue(new Error('tg'));
    const debug = jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    await service.refreshMemberTags();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('не определить создателя'));
    expect(bot.api.setChatMemberTag).toHaveBeenCalled();
  });

  it('ошибка проверки прав не роняет обход', async () => {
    const { service, bot } = setup();
    bot.api.getChatMember.mockRejectedValue(new Error('tg'));
    const debug = jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    await expect(service.refreshMemberTags()).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });

  describe('первое наречение', () => {
    it('нарекает, объявляет и сохраняет курсор', async () => {
      const { service, bot, tags, deepSeek } = setup({
        rows: userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES),
      });

      await service.refreshMemberTags();

      expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'подмыхан');
      const [chatId, text, opts] = bot.api.sendMessage.mock.calls[0];
      expect(chatId).toBe(CHAT);
      expect(text).toBe('нарекаю вася - подмыхан, дымит как паровоз, хули');
      expect(opts).toMatchObject({ reply_to_message_id: 1000 });
      expect(tags.save).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: CHAT,
          userId: USER,
          tag: 'подмыхан',
          lastMessageId: TROLL_MEMBER_TAG_MIN_MESSAGES,
          lastEvaluatedAt: expect.any(Date),
        })
      );
      expect(deepSeek.completeText).toHaveBeenCalledWith(
        expect.stringContaining('нарекаю'),
        expect.stringContaining('подмыхан'),
        expect.objectContaining({ label: 'наречение' })
      );
    });

    it('меньше порога сообщений — не нарекаем', async () => {
      const { service, bot } = setup({
        rows: userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES - 1),
      });
      await service.refreshMemberTags();
      expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    });

    it('за прогон — не больше двух первых наречений, по объёму реплик', async () => {
      const rows = [
        ...userRows(1, 30, { userName: 'Много' }),
        ...userRows(2, 20, { userName: 'Средне' }),
        ...userRows(3, 12, { userName: 'Мало' }),
      ];
      const { service, bot } = setup({ rows });

      await service.refreshMemberTags();

      expect(bot.api.setChatMemberTag).toHaveBeenCalledTimes(2);
      expect(bot.api.setChatMemberTag).toHaveBeenNthCalledWith(1, CHAT, 1, 'подмыхан');
      expect(bot.api.setChatMemberTag).toHaveBeenNthCalledWith(2, CHAT, 2, 'подмыхан');
    });
  });

  describe('смена существующего тега', () => {
    const oldEval = new Date(Date.now() - (TROLL_MEMBER_TAG_COOLDOWN_HOURS + 1) * 3600 * 1000);

    it('меняет тег при 10 новых сообщениях после суток', async () => {
      const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100 });
      const { service, bot, tags } = setup({
        rows,
        stored: [
          storedTag({ lastMessageId: 100 - TROLL_MEMBER_TAG_NEW_MESSAGES, lastEvaluatedAt: oldEval }),
        ],
      });

      await service.refreshMemberTags();

      expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'подмыхан');
      expect(tags.save).toHaveBeenCalledWith(expect.objectContaining({ id: 5, lastMessageId: 100 }));
    });

    it('не чаще раза в сутки: свежая оценка — пропуск', async () => {
      const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100 });
      const { service, bot } = setup({
        rows,
        stored: [
          storedTag({ lastMessageId: 90, lastEvaluatedAt: new Date() }),
        ],
      });
      await service.refreshMemberTags();
      expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    });

    it('меньше 10 новых сообщений — пропуск', async () => {
      const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100 });
      const { service, bot } = setup({
        rows,
        stored: [
          storedTag({ lastMessageId: 92, lastEvaluatedAt: oldEval }),
        ],
      });
      await service.refreshMemberTags();
      expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    });

    it('реплики без id не считаются новыми', async () => {
      const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES).map((row) => ({ ...row, id: null }));
      const { service, bot } = setup({
        rows,
        stored: [storedTag({ lastMessageId: null, lastEvaluatedAt: null })],
      });
      await service.refreshMemberTags();
      expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    });

    it('null lastEvaluatedAt считается «давно»', async () => {
      const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100 });
      const { service, bot } = setup({
        rows,
        stored: [storedTag({ lastMessageId: 90, lastEvaluatedAt: null })],
      });
      await service.refreshMemberTags();
      expect(bot.api.setChatMemberTag).toHaveBeenCalled();
    });

    it('тот же тег — не применяем, но двигаем курсор оценки', async () => {
      const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100 });
      const { service, bot, tags } = setup({
        rows,
        stored: [
          storedTag({ tag: 'подмыхан', lastMessageId: 90, lastEvaluatedAt: oldEval }),
        ],
      });

      await service.refreshMemberTags();

      expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
      expect(tags.update).toHaveBeenCalledWith(
        { id: 5 },
        expect.objectContaining({ lastMessageId: 100, lastEvaluatedAt: expect.any(Date) })
      );
      expect(tags.save).not.toHaveBeenCalled();
    });

    it('смена и первое наречение идут вместе, смены — первыми', async () => {
      const rows = [
        ...userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100, userName: 'Старый' }),
        ...userRows(77, TROLL_MEMBER_TAG_MIN_MESSAGES, { userName: 'Новый' }),
      ];
      const { service, bot } = setup({
        rows,
        stored: [
          storedTag({ lastMessageId: 90, lastEvaluatedAt: oldEval, userName: 'Старый' }),
        ],
      });

      await service.refreshMemberTags();

      expect(bot.api.setChatMemberTag).toHaveBeenCalledTimes(2);
      expect(bot.api.setChatMemberTag).toHaveBeenNthCalledWith(1, CHAT, USER, 'подмыхан');
      expect(bot.api.setChatMemberTag).toHaveBeenNthCalledWith(2, CHAT, 77, 'подмыхан');
    });
  });

  it('передаёт занятые теги других участников, чтобы не повторяться', async () => {
    const other = 555;
    const rows = [
      ...userRows(other, TROLL_MEMBER_TAG_MIN_MESSAGES, { userName: 'Другой' }),
      ...userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES),
    ];
    const { service, deepSeek } = setup({
      rows,
      stored: [storedTag({ id: 7, userId: other, tag: 'пробив-мастер', lastMessageId: null })],
    });

    await service.refreshMemberTags();

    const systems = deepSeek.completeJson.mock.calls.map((call) => call[0] as string);
    const withOccupied = systems.filter(
      (system) => system.includes('Уже занятые теги') && system.includes('пробив-мастер')
    );
    expect(withOccupied.length).toBeGreaterThan(0);
    expect(withOccupied[0]).toContain('Не повторяй');
  });

  it('свой тег не считается занятым', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_NEW_MESSAGES, { newestId: 100 });
    const { service, deepSeek } = setup({
      rows,
      stored: [
        storedTag({ tag: 'старый-тег', lastMessageId: 90, lastEvaluatedAt: new Date(0) }),
      ],
    });
    await service.refreshMemberTags();
    const system = deepSeek.completeJson.mock.calls[0][0] as string;
    expect(system).not.toContain('старый-тег');
  });

  it('пустой ответ модели курсор не двигает', async () => {
    const { service, tags } = setup({ suggestion: null });
    await service.refreshMemberTags();
    expect(tags.save).not.toHaveBeenCalled();
    expect(tags.update).not.toHaveBeenCalled();
  });

  it('пустые реплики — модель не вызывается', async () => {
    const { service, deepSeek } = setup({
      rows: userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES, { content: () => '   ' }),
    });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('реплики без userId пропускаются', async () => {
    const rows = [
      ...userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES),
      { ...userRows(USER, 1)[0], id: 999, userId: null },
    ];
    const { service, deepSeek } = setup({ rows });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).toHaveBeenCalledTimes(1);
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
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'докер-обжора');
  });

  it('если все теги оскорбительные — не нарекаем', async () => {
    const { service, bot, tags } = setup({
      suggestion: { tags: [{ tag: 'долбоёб', reason: 'x', relevance: 1 }] },
    });
    await service.refreshMemberTags();
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
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'кальянный лорд');
  });

  it('ошибка отправки объявления логируется, но тег сохраняется', async () => {
    const { service, bot, tags } = setup();
    bot.api.sendMessage.mockRejectedValue(new Error('tg'));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await service.refreshMemberTags();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('объявление'));
    expect(tags.save).toHaveBeenCalled();
  });

  it('ошибка setChatMemberTag не роняет обход', async () => {
    const { service, bot, tags } = setup();
    bot.api.setChatMemberTag.mockRejectedValue(new Error('no rights'));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await expect(service.refreshMemberTags()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no rights'));
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('сбой одного участника не мешает остальным', async () => {
    const rows = [
      ...userRows(1, 30, { userName: 'Первый' }),
      ...userRows(2, 20, { userName: 'Второй' }),
    ];
    const { service, bot } = setup({ rows });
    bot.api.setChatMemberTag.mockRejectedValueOnce(new Error('boom'));
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).toHaveBeenCalledTimes(2);
  });

  it('расшифровка не превышает лимит', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES, {
      content: () => 'x'.repeat(600),
    });
    const { service, deepSeek } = setup({ rows });
    await service.refreshMemberTags();
    const payload = deepSeek.completeJson.mock.calls[0][1] as string;
    expect(payload.length).toBeLessThanOrEqual(TROLL_MEMBER_TAG_TRANSCRIPT_CHARS + 64);
    expect(payload).toContain('<user_message>');
  });

  it('без ответа модели объявление падает в шаблон с именем', async () => {
    const { service, bot } = setup({
      rows: userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES, { userName: null }),
      announcement: null,
    });
    await service.refreshMemberTags();
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('нарекаю участник');
  });

  it('без messageId объявление уходит без ответа', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES).map((row) => ({
      ...row,
      messageId: null,
    }));
    const { service, bot } = setup({ rows });
    await service.refreshMemberTags();
    expect(bot.api.sendMessage.mock.calls[0][2]).not.toHaveProperty('reply_to_message_id');
  });

  it('null-контент и нечисловой relevance не ломают отбор', async () => {
    const rows = userRows(USER, TROLL_MEMBER_TAG_MIN_MESSAGES);
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
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'кальян');
  });

  it('без topics сохраняет null', async () => {
    const { service, tags } = setup({
      suggestion: { tags: [{ tag: 'подмыхан', relevance: 1 }] },
    });
    await service.refreshMemberTags();
    expect(tags.save).toHaveBeenCalledWith(expect.objectContaining({ topics: null }));
  });

  it('не-Error в сбое логируется строкой', async () => {
    const { service, history } = setup();
    history.find.mockRejectedValue('oops');
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    await service.refreshMemberTags();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('oops'));
  });
});
