import { TrollReplyFormatter } from './troll-reply-formatter';

describe('TrollReplyFormatter — buildCriminalReply', () => {
  const formatter = new TrollReplyFormatter();

  it('формирует высокую серьёзность, статьи и подавляет общий вывод', () => {
    const reply = formatter.buildCriminalReply(
      {
        probability: 0.9,
        articles: [
          { code: 'ст. 158', title: 'Кража', reason: 'украл' },
          { code: '!!!', title: 'пусто', reason: 'п' },
          { code: 'ст. 2', title: '', reason: '' },
          null,
        ],
        reason: 'общий',
      } as any,
      0.9,
      { criminalHighThreshold: 0.8 } as any
    );

    expect(reply).toContain('Почти наверняка состав преступления');
    expect(reply).toContain('ст. 158');
    expect(reply).toContain('Кража');
    expect(reply).toContain('украл');
    expect(reply).toContain('ст. 2');
    expect(reply).not.toContain('Почему:');
  });

  it('формирует мягкую шапку и общий вывод для пустого списка статей', () => {
    const reply = formatter.buildCriminalReply(
      { probability: 0.5, articles: [], reason: 'общий' } as any,
      0.5,
      { criminalHighThreshold: 0.8 } as any
    );

    expect(reply).toContain('Похоже на статью');
    expect(reply).toContain('Почему: общий');
  });

  it('переживает articles не-массив и отсутствие общего вывода', () => {
    const reply = formatter.buildCriminalReply(
      { probability: 0.5, articles: null, reason: '' } as any,
      0.5,
      { criminalHighThreshold: 0.8 } as any
    );

    expect(reply).toContain('Похоже на статью');
    expect(reply).not.toContain('Почему:');
  });
});

describe('TrollReplyFormatter — formatDefectReport', () => {
  const formatter = new TrollReplyFormatter();

  it('собирает полный отчёт с реплаем, диагностикой и обрезкой', () => {
    const report = formatter.formatDefectReport(
      { id: 7, sourceChatId: 100, sourceChatTitle: 'Чат' } as any,
      { content: 'ответ бота' } as any,
      { userName: 'Вася', userId: 42, content: 'x'.repeat(400) } as any,
      { severity: 'high', summary: 'с', problems: ['п'], fixes: ['ф'] }
    );

    expect(report).toContain('Дефект #7, серьёзность high');
    expect(report).toContain('Чат (100)');
    expect(report).toContain('бот отвечал: Вася (42)');
    expect(report).toContain('…');
    expect(report).toContain('диагностика: с');
    expect(report).toContain('что не так:');
    expect(report).toContain('как надо было:');
  });

  it('собирает краткий отчёт без реплая и без диагностики', () => {
    const report = formatter.formatDefectReport(
      { id: 8, sourceChatId: null, sourceChatTitle: null } as any,
      { content: 'ответ бота' } as any,
      { userName: null, userId: null, content: 'вопрос' } as any,
      { severity: 'low', summary: '', problems: [], fixes: [] }
    );

    expect(report).toContain('чат: без названия (?)');
    expect(report).toContain('бот отвечал: участник (?), реплика');
    expect(report).not.toContain('не реплаем');
    expect(report).not.toContain('диагностика:');
  });

  it('пишет, что бот отвечал не реплаем', () => {
    const report = formatter.formatDefectReport(
      { id: 9, sourceChatId: 1, sourceChatTitle: 'Чат' } as any,
      { content: 'ответ' } as any,
      null,
      { severity: 'low', summary: '', problems: [], fixes: [] }
    );

    expect(report).toContain('бот отвечал не реплаем');
  });
});

describe('TrollReplyFormatter — определение медиа и ссылок', () => {
  const formatter = new TrollReplyFormatter();

  it.each([
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
  ])('describeMediaKind распознаёт %p', (message, expected) => {
    expect(formatter.describeMediaKind(message as any)).toBe(expected);
  });

  it('messageHasLink видит url и text_link', () => {
    expect(formatter.messageHasLink({ entities: [{ type: 'url' }] } as any)).toBe(true);
    expect(formatter.messageHasLink({ caption_entities: [{ type: 'text_link' }] } as any)).toBe(
      true
    );
    expect(formatter.messageHasLink({ entities: [{ type: 'bold' }] } as any)).toBe(false);
    expect(formatter.messageHasLink({} as any)).toBe(false);
  });

  it('buildHistoryEntry собирает текст, медиа и ссылки', () => {
    expect(formatter.buildHistoryEntry('привет', null, false, 100)).toBe('привет');
    expect(formatter.buildHistoryEntry('', 'картинка', false, 100)).toBe('[картинка]');
    expect(formatter.buildHistoryEntry('смотри https://x.com', null, true, 100)).toContain(
      '[ссылка]'
    );
    expect(formatter.buildHistoryEntry('ок', null, false, 100)).toBeNull();
    expect(formatter.buildHistoryEntry('', null, false, 100)).toBeNull();
  });
});

describe('TrollReplyFormatter — простые помощники', () => {
  const formatter = new TrollReplyFormatter();

  it('describeUser собирает имя и username', () => {
    expect(formatter.describeUser(undefined)).toBe('Аноним');
    expect(formatter.describeUser({ id: 1 } as any)).toBe('Аноним');
    expect(formatter.describeUser({ id: 1, username: 'v' } as any)).toBe('Аноним (@v)');
    expect(formatter.describeUser({ id: 1, first_name: 'Вася' } as any)).toBe('Вася');
    expect(formatter.describeUser({ id: 1, first_name: 'Вася', last_name: 'П' } as any)).toBe(
      'Вася П'
    );
    expect(
      formatter.describeUser({ id: 1, first_name: 'Вася', last_name: 'П', username: 'v' } as any)
    ).toBe('Вася П (@v)');
  });

  it('escapeHtml экранирует спецсимволы', () => {
    expect(formatter.escapeHtml('<a>&')).toBe('&lt;a&gt;&amp;');
  });

  it('logText схлопывает переносы и обрезает', () => {
    expect(formatter.logText('a\nb')).toBe('«a ⏎ b»');
    expect(formatter.logText('x'.repeat(2000), 10)).toBe(`«${'x'.repeat(10)}…»`);
    expect(formatter.logText('коротко')).toBe('«коротко»');
  });

  it('describeMessageRefs собирает метку связей', () => {
    expect(formatter.describeMessageRefs(undefined, null)).toBe('');
    expect(formatter.describeMessageRefs(null, 15)).toBe('');
    expect(formatter.describeMessageRefs(17, 15)).toBe(' [msg 17, replyTo 15]');
    expect(formatter.describeMessageRefs(17, null)).toBe(' [msg 17]');
    expect(formatter.describeMessageRefs(17, undefined)).toBe(' [msg 17]');
  });

  it('tag и pct форматируют логи', () => {
    expect(formatter.tag(undefined)).toBe('chat=-');
    expect(formatter.tag(5)).toBe('chat=5');
    expect(formatter.tag(5, 7)).toBe('chat=5 user=7');
    expect(formatter.pct(0.5)).toBe('50%');
  });

  it('cut обрезает и переживает пустой текст', () => {
    expect(formatter.cut('  много   пробелов  ', 100)).toBe('много пробелов');
    expect(formatter.cut('abcdef', 3)).toBe('abc…');
    expect(formatter.cut('', 5)).toBe('');
    expect(formatter.cut(null as any, 5)).toBe('');
  });

  it('describeError достаёт сообщение ошибки', () => {
    expect(formatter.describeError(new Error('boom'))).toBe('boom');
    expect(formatter.describeError('text')).toBe('text');
  });

  it('messageText берёт текст или подпись', () => {
    expect(formatter.messageText({ message: { text: 'текст' } } as any)).toBe('текст');
    expect(formatter.messageText({ message: { caption: ' подпись ' } } as any)).toBe('подпись');
    expect(formatter.messageText({ message: {} } as any)).toBe('');
    expect(formatter.messageText({ message: undefined } as any)).toBe('');
  });

  it('normalizeMirrorWord оставляет одно слово из букв и дефиса', () => {
    expect(formatter.normalizeMirrorWord('  хуйвет!!!  таки')).toBe('хуйвет');
    expect(formatter.normalizeMirrorWord('привет мир')).toBe('привет');
    expect(formatter.normalizeMirrorWord('---')).toBe('');
  });
});
