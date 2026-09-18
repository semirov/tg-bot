import {
  ConversationMessage,
  buildConversationContext,
  formatConversationPause,
} from './troll-context';

interface Row extends ConversationMessage {
  userName: string;
  userId: number;
}

const BASE = new Date('2026-09-15T09:00:00.000Z').getTime();

function row(minutesAgo: number, content: string, name = 'Вася'): Row {
  return {
    role: 'user',
    content,
    userName: name,
    userId: 111,
    createdAt: new Date(BASE - minutesAgo * 60000),
  };
}

/** Как из БД: реплики приходят от свежих к старым. */
function newestFirst(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

const AN_HOUR = 60 * 60000;
const WIDE = { gapMs: AN_HOUR, maxTurns: 200, maxChars: 12000 };

function render(rows: Row[], options = WIDE): string {
  return buildConversationContext(newestFirst(rows), options)
    .map((item) =>
      item.kind === 'pause' ? `[ПАУЗА ${formatConversationPause(item.gapMs)}]` : item.row.content
    )
    .join(' | ');
}

describe('buildConversationContext', () => {
  it('непрерывную беседу отдаёт целиком и в хронологическом порядке', () => {
    const rows = [row(0, 'последнее'), row(10, 'середина'), row(30, 'начало')];
    const out = buildConversationContext(newestFirst(rows), WIDE);

    expect(out).toHaveLength(3);
    expect(out.every((item) => item.kind === 'message')).toBe(true);
    expect(render(rows)).toBe('начало | середина | последнее');
  });

  it('длинную паузу помечает и оставляет старую беседу ниже метки', () => {
    const rows = [row(0, 'кальян'), row(5, 'про чашу'), row(125, 'интернет флапает'), row(130, 'Дом.ру')];
    const out = buildConversationContext(newestFirst(rows), WIDE);
    const rendered = render(rows);

    expect(out.filter((item) => item.kind === 'pause')).toHaveLength(1);
    expect(rendered).toContain('[ПАУЗА 2 ч]');
    expect(rendered.indexOf('[ПАУЗА 2 ч]')).toBeGreaterThan(rendered.indexOf('Дом.ру'));
    expect(rendered.endsWith('кальян')).toBe(true);
    // Сутки помним: реплики до паузы остаются в контексте, но как старая беседа.
    expect(rendered).toContain('интернет флапает');
  });

  it('пауза ровно в порог разрывом не считается, чуть больше — считается', () => {
    const exact = buildConversationContext(
      newestFirst([row(0, 'сейчас'), row(60, 'ровно час назад')]),
      WIDE
    );
    const over = buildConversationContext(
      newestFirst([row(0, 'сейчас'), row(61, 'чуть больше часа назад')]),
      WIDE
    );

    expect(exact.every((item) => item.kind === 'message')).toBe(true);
    expect(over.some((item) => item.kind === 'pause')).toBe(true);
  });

  it('единственная свежая реплика не тянет за собой метку паузы', () => {
    const out = buildConversationContext(newestFirst([row(0, 'новая тема')]), WIDE);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('message');
  });

  it('оценивает реплику без имени автора (сервисные сообщения)', () => {
    const rows: ConversationMessage[] = [
      {
        role: 'user',
        content: 'без имени',
        userName: null,
        userId: null,
        createdAt: new Date(BASE),
      },
    ];
    const out = buildConversationContext(rows, { gapMs: AN_HOUR, maxTurns: 5, maxChars: 10 });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('message');
  });

  it('при переполнении бюджета отбрасывает самые старые реплики', () => {
    const rows = [row(0, 'свежая'), row(5, 'X'.repeat(200)), row(10, 'Y'.repeat(200)), row(15, 'Z'.repeat(200))];
    const out = buildConversationContext(newestFirst(rows), {
      gapMs: AN_HOUR,
      maxTurns: 200,
      maxChars: 300,
    });

    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('message');
    expect(render(rows, { gapMs: AN_HOUR, maxTurns: 200, maxChars: 300 })).not.toContain(
      'Z'.repeat(200)
    );
    expect(render(rows, { gapMs: AN_HOUR, maxTurns: 200, maxChars: 300 })).toContain('свежая');
  });

  it('свежую реплику оставляет даже если она одна больше бюджета', () => {
    const out = buildConversationContext(
      newestFirst([row(0, 'H'.repeat(5000)), row(5, 'старая')]),
      { gapMs: AN_HOUR, maxTurns: 200, maxChars: 100 }
    );

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('message');
  });

  it('соблюдает потолок числа реплик, оставляя самые свежие', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(index * 5, `реплика-${index}`));
    const out = buildConversationContext(newestFirst(rows), {
      gapMs: AN_HOUR,
      maxTurns: 3,
      maxChars: 12000,
    });

    expect(out).toHaveLength(3);
    expect(
      out.map((item) => (item.kind === 'message' ? item.row.content : 'pause')).join(',')
    ).toBe('реплика-2,реплика-1,реплика-0');
  });

  it('несколько пауз дают несколько бесед в хронологии', () => {
    const rows = [row(0, 'D'), row(5, 'C'), row(70, 'B'), row(200, 'A'), row(205, 'A-1')];
    const rendered = render(rows);

    expect((rendered.match(/\[ПАУЗА/g) ?? []).length).toBe(2);
    expect(rendered.startsWith('A-1')).toBe(true);
  });
});

describe('formatConversationPause', () => {
  it.each([
    [45 * 60000, '45 мин'],
    [90 * 60000, '1 ч 30 мин'],
    [120 * 60000, '2 ч'],
    [23 * 3600000, '23 ч'],
    [1000, '1 мин'],
  ])('переводит %i мс в «%s»', (gapMs, expected) => {
    expect(formatConversationPause(gapMs)).toBe(expected);
  });
});
