jest.mock('./deepseek.service', () => ({ DeepSeekService: class DeepSeekService {} }));

import { TrollMemberTagsService } from './troll-member-tags.service';
import { TROLL_MEMBER_TAG_COOLDOWN_HOURS, TROLL_MEMBER_TAG_TRANSCRIPT_CHARS } from '../constants/troll-limits';

const CHAT = -100500;
const USER = 42;
const OWNER = 777;

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

function setup(
  options: {
    chats?: unknown[];
    rows?: unknown[];
    stored?: unknown[];
    suggestion?: unknown;
    enabled?: boolean;
    tagsEnabled?: boolean;
    botInfo?: unknown;
    member?: unknown;
    admins?: unknown;
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
  const config = { ownerId: OWNER };
  const deepSeek = {
    completeJson: jest
      .fn()
      .mockResolvedValue(
        options.suggestion === undefined
          ? {
              topics: ['кальян', 'мтс'],
              tags: [{ tag: 'подмыхан', reason: 'дымит как паровоз', relevance: 0.9 }],
            }
          : options.suggestion
      ),
  };
  const settings = {
    current: {
      enabled: options.enabled ?? true,
      memberTagsEnabled: options.tagsEnabled ?? true,
    },
  };
  const chats = { find: jest.fn().mockResolvedValue(options.chats ?? [{ chatId: CHAT }]) };
  const history = {
    find: jest
      .fn()
      .mockResolvedValue(options.rows ?? [historyRow({ id: 1 }), historyRow({ id: 2 })]),
  };
  const tags = {
    find: jest.fn().mockResolvedValue(options.stored ?? []),
    save: jest.fn().mockResolvedValue(undefined),
  };

  const service = new TrollMemberTagsService(
    bot as never,
    config as never,
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
    const { service, chats } = setup({ enabled: false });
    await service.refreshMemberTags();
    expect(chats.find).not.toHaveBeenCalled();

    const second = setup({ tagsEnabled: false });
    await second.service.refreshMemberTags();
    expect(second.chats.find).not.toHaveBeenCalled();
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

  it('пустые реплики — модель не вызывается', async () => {
    const { service, deepSeek } = setup({
      rows: [historyRow({ id: 1, content: '   ' }), historyRow({ id: 2, content: '' })],
    });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('реплики без userId пропускаются', async () => {
    const { service, deepSeek } = setup({
      rows: [
        historyRow({ id: 1, userId: null }),
        historyRow({ id: 2, userId: null }),
        historyRow({ id: 3 }),
        historyRow({ id: 4 }),
      ],
    });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).toHaveBeenCalledTimes(1);
  });

  it('бот не админ/без права — чат пропускается', async () => {
    const { service, history } = setup({ member: { status: 'member' } });
    await service.refreshMemberTags();
    expect(history.find).not.toHaveBeenCalled();

    const noRight = setup({ member: { status: 'administrator', can_manage_tags: false } });
    await noRight.service.refreshMemberTags();
    expect(noRight.history.find).not.toHaveBeenCalled();
  });

  it('без botInfo чат пропускается', async () => {
    const { service, history } = setup({ botInfo: null });
    await service.refreshMemberTags();
    expect(history.find).not.toHaveBeenCalled();
  });

  it('ошибка проверки прав не роняет обход', async () => {
    const { service, bot } = setup();
    bot.api.getChatMember.mockRejectedValue(new Error('tg'));
    const debug = jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);

    await expect(service.refreshMemberTags()).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });

  it('нарекает участника, объявляет и сохраняет тег', async () => {
    const { service, bot, tags, deepSeek } = setup();

    await service.refreshMemberTags();

    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'подмыхан');
    const [chatId, text, opts] = bot.api.sendMessage.mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(text).toBe('нарекаю Вася — подмыхан! потому что дымит как паровоз');
    expect(opts).toMatchObject({ reply_to_message_id: 10 });
    expect(tags.save).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT,
        userId: USER,
        userName: 'Вася',
        tag: 'подмыхан',
        reason: 'дымит как паровоз',
        topics: 'кальян, мтс',
      })
    );
    expect(deepSeek.completeJson).toHaveBeenCalled();
  });

  it('участник с одним сообщением не анализируется', async () => {
    const { service, deepSeek } = setup({ rows: [historyRow({ id: 1 })] });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('владельца не трогаем', async () => {
    const { service, deepSeek } = setup({
      rows: [historyRow({ id: 1, userId: OWNER }), historyRow({ id: 2, userId: OWNER })],
    });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('администраторов не трогаем', async () => {
    const { service, deepSeek } = setup({
      admins: [{ user: { id: USER } }],
    });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
  });

  it('ошибка получения админов не мешает обработать участника', async () => {
    const { service, bot, deepSeek } = setup();
    bot.api.getChatAdministrators.mockRejectedValue(new Error('tg'));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    await service.refreshMemberTags();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('не получить админов'));
    expect(deepSeek.completeJson).toHaveBeenCalled();
  });

  it('антифлуд: свежий тег не меняем', async () => {
    const { service, bot, deepSeek } = setup({
      stored: [{ id: 5, chatId: CHAT, userId: USER, tag: 'старый', updatedAt: new Date() }],
    });
    await service.refreshMemberTags();
    expect(deepSeek.completeJson).not.toHaveBeenCalled();
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
  });

  it('после кулдауна участника обрабатываем снова', async () => {
    const past = new Date(Date.now() - (TROLL_MEMBER_TAG_COOLDOWN_HOURS + 1) * 3600 * 1000);
    const { service, bot, tags } = setup({
      stored: [{ id: 5, chatId: CHAT, userId: USER, tag: 'старый', updatedAt: past }],
    });
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).toHaveBeenCalledWith(CHAT, USER, 'подмыхан');
    expect(tags.save).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
  });

  it('тот же тег повторно не применяем', async () => {
    const past = new Date(Date.now() - (TROLL_MEMBER_TAG_COOLDOWN_HOURS + 1) * 3600 * 1000);
    const { service, bot, tags } = setup({
      stored: [{ id: 5, chatId: CHAT, userId: USER, tag: 'подмыхан', updatedAt: past }],
    });
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('пустой ответ модели — ничего не делаем', async () => {
    const { service, bot, tags } = setup({ suggestion: null });
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
    expect(tags.save).not.toHaveBeenCalled();
  });

  it('кандидаты без валидного тега отсеиваются', async () => {
    const { service, bot } = setup({
      suggestion: { tags: [{ tag: '🎉', reason: 'x', relevance: 1 }] },
    });
    await service.refreshMemberTags();
    expect(bot.api.setChatMemberTag).not.toHaveBeenCalled();
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
    const admin = 111;
    const { service, bot } = setup({
      rows: [
        historyRow({ id: 3, userId: admin, userName: 'Админ' }),
        historyRow({ id: 2, userId: admin, userName: 'Админ' }),
        historyRow({ id: 1, userId: USER }),
        historyRow({ id: 4, userId: USER }),
      ],
    });
    bot.api.setChatMemberTag.mockRejectedValueOnce(new Error('boom'));

    await service.refreshMemberTags();

    expect(bot.api.setChatMemberTag).toHaveBeenCalledTimes(2);
  });

  it('расшифровка не превышает лимит и содержит свежую реплику', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      historyRow({ id: index + 1, content: 'x'.repeat(300) })
    );
    const { service, deepSeek } = setup({ rows });
    await service.refreshMemberTags();

    const payload = deepSeek.completeJson.mock.calls[0][1] as string;
    expect(payload.length).toBeLessThanOrEqual(TROLL_MEMBER_TAG_TRANSCRIPT_CHARS + 64);
    expect(payload).toContain('<user_message>');
  });

  it('имя участника подставляется безопасным дефолтом', async () => {
    const { service, bot } = setup({
      rows: [historyRow({ id: 1, userName: null }), historyRow({ id: 2, userName: null })],
    });
    await service.refreshMemberTags();
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('нарекаю участник');
  });

  it('без reason объявление всё равно уходит', async () => {
    const { service, bot } = setup({
      suggestion: { tags: [{ tag: 'подмыхан', relevance: 0.5 }] },
    });
    await service.refreshMemberTags();
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain('ты сам всё понимаешь');
  });

  it('без messageId объявление уходит без ответа', async () => {
    const { service, bot } = setup({
      rows: [historyRow({ id: 1, messageId: null }), historyRow({ id: 2, messageId: null })],
    });
    await service.refreshMemberTags();
    expect(bot.api.sendMessage.mock.calls[0][2]).not.toHaveProperty('reply_to_message_id');
  });

  it('null-контент и нечисловой relevance не ломают отбор', async () => {
    const { service, bot } = setup({
      rows: [
        historyRow({ id: 1, content: null }),
        historyRow({ id: 2, content: 'реплика' }),
      ],
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
    const { service, tags } = setup({ suggestion: { tags: [{ tag: 'подмыхан', relevance: 1 }] } });
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
