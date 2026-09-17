import { DefectCandidate, isSameAnswer, normalizeMatchText, pickDefectAnswer } from './troll-defect';

const now = new Date('2026-09-17T12:00:00Z');

function candidate(overrides: Partial<DefectCandidate> & { id: number }): DefectCandidate {
  return {
    chatId: -100500,
    content: 'иди нахуй, инженер',
    createdAt: now,
    ...overrides,
  };
}

describe('normalizeMatchText', () => {
  it('схлопывает переносы и повторные пробелы', () => {
    expect(normalizeMatchText('иии,   ии\n\nты  чё')).toBe('иии, ии ты чё');
  });

  it('убирает невидимые символы', () => {
    expect(normalizeMatchText('при\u200bвет\ufeff!')).toBe('привет!');
  });

  it('не зависит от регистра', () => {
    expect(normalizeMatchText('ХУЙВЕТ')).toBe(normalizeMatchText('хуйвет'));
  });

  it('пустая строка остаётся пустой', () => {
    expect(normalizeMatchText('   \n  ')).toBe('');
  });
});

describe('isSameAnswer', () => {
  it('совпадает при разных переносах', () => {
    expect(isSameAnswer('иди нахуй, инженер', 'иди\nнахуй,   инженер')).toBe(true);
  });

  it('совпадает, если срезали концевую точку', () => {
    expect(isSameAnswer('иди нахуй, инженер', 'иди нахуй, инженер.')).toBe(true);
  });

  it('совпадает, если добавили кавычки по краям', () => {
    expect(isSameAnswer('иди нахуй', '«иди нахуй»')).toBe(true);
  });

  it('разные ответы не совпадают', () => {
    expect(isSameAnswer('иди нахуй, инженер', 'иди нахуй, инженер и не спорь')).toBe(false);
  });

  it('пустой текст не совпадает ни с чем', () => {
    expect(isSameAnswer('', 'иди нахуй')).toBe(false);
    expect(isSameAnswer('иди нахуй', '   ')).toBe(false);
  });
});

describe('pickDefectAnswer', () => {
  it('берёт ответ, совпавший с присланным текстом по нормализации', () => {
    const rows = [
      candidate({ id: 1, content: 'первый ответ' }),
      candidate({ id: 2, content: 'иди нахуй, инженер' }),
    ];
    const match = pickDefectAnswer(rows, { text: 'Иди нахуй,   инженер.' });
    expect(match?.candidate.id).toBe(2);
    expect(match?.exact).toBe(false);
  });

  it('совпадение с точностью до пробелов считается точным', () => {
    const rows = [candidate({ id: 1, content: 'иди нахуй, инженер' })];
    const match = pickDefectAnswer(rows, { text: 'иди нахуй,\nинженер' });
    expect(match?.candidate.id).toBe(1);
    expect(match?.exact).toBe(true);
  });

  it('точное совпадение важнее нормализованного', () => {
    const rows = [
      candidate({ id: 1, content: 'иди нахуй' }),
      candidate({ id: 2, content: 'иди нахуй.' }),
    ];
    const match = pickDefectAnswer(rows, { text: 'иди нахуй.' });
    expect(match?.candidate.id).toBe(2);
    expect(match?.exact).toBe(true);
  });

  it('при равном совпадении берёт ближайший по времени', () => {
    const rows = [
      candidate({ id: 1, content: 'иди нахуй', createdAt: new Date('2026-09-17T09:00:00Z') }),
      candidate({ id: 2, content: 'иди нахуй', createdAt: new Date('2026-09-17T11:58:00Z') }),
    ];
    const match = pickDefectAnswer(rows, {
      text: 'иди нахуй',
      sentAt: new Date('2026-09-17T11:59:00Z'),
    });
    expect(match?.candidate.id).toBe(2);
  });

  it('не берёт совпадение из другого времени, если известна дата форварда', () => {
    const rows = [
      candidate({ id: 1, content: 'иди нахуй', createdAt: new Date('2026-09-16T09:00:00Z') }),
    ];
    const match = pickDefectAnswer(rows, {
      text: 'иди нахуй',
      sentAt: new Date('2026-09-17T12:00:00Z'),
      windowMs: 5 * 60 * 1000,
    });
    expect(match).toBeNull();
  });

  it('без совпадений возвращает null', () => {
    const rows = [candidate({ id: 1, content: 'иди нахуй' })];
    expect(pickDefectAnswer(rows, { text: 'совсем другой текст' })).toBeNull();
  });

  it('на пустом тексте возвращает null', () => {
    const rows = [candidate({ id: 1 })];
    expect(pickDefectAnswer(rows, { text: '   ' })).toBeNull();
  });
});
