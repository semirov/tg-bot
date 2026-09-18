import { pluralizeRu } from './russian-plural';

describe('pluralizeRu', () => {
  const yearForms = ['год', 'года', 'лет'] as const;

  const yearCases: Array<[number, string]> = [
    [0, 'лет'],
    [1, 'год'],
    [2, 'года'],
    [3, 'года'],
    [4, 'года'],
    [5, 'лет'],
    [10, 'лет'],
    [11, 'лет'],
    [12, 'лет'],
    [13, 'лет'],
    [14, 'лет'],
    [15, 'лет'],
    [20, 'лет'],
    [21, 'год'],
    [22, 'года'],
    [23, 'года'],
    [24, 'года'],
    [25, 'лет'],
    [100, 'лет'],
    [101, 'год'],
    [102, 'года'],
    [110, 'лет'],
    [111, 'лет'],
    [112, 'лет'],
    [121, 'год'],
    [122, 'года'],
    [125, 'лет'],
  ];

  it.each(yearCases)('склоняет «год» для %i', (count, expected) => {
    expect(pluralizeRu(count, yearForms)).toBe(expected);
  });

  it('соблюдает правило 11–14 даже когда последняя цифра 1–4', () => {
    for (const count of [11, 12, 13, 14, 111, 112, 113, 114]) {
      expect(pluralizeRu(count, ['час', 'часа', 'часов'])).toBe('часов');
    }
  });

  it('использует переданные формы для каждой группы', () => {
    const forms = ['минуту', 'минуты', 'минут'] as const;
    expect(pluralizeRu(1, forms)).toBe('минуту');
    expect(pluralizeRu(2, forms)).toBe('минуты');
    expect(pluralizeRu(5, forms)).toBe('минут');
    expect(pluralizeRu(11, forms)).toBe('минут');
    expect(pluralizeRu(21, forms)).toBe('минуту');
    expect(pluralizeRu(22, forms)).toBe('минуты');
    expect(pluralizeRu(25, forms)).toBe('минут');
  });

  it('поддерживает слова, у которых формы 1 и 5+ совпадают', () => {
    const forms = ['раз', 'раза', 'раз'] as const;
    expect(pluralizeRu(1, forms)).toBe('раз');
    expect(pluralizeRu(2, forms)).toBe('раза');
    expect(pluralizeRu(4, forms)).toBe('раза');
    expect(pluralizeRu(5, forms)).toBe('раз');
    expect(pluralizeRu(11, forms)).toBe('раз');
    expect(pluralizeRu(21, forms)).toBe('раз');
    expect(pluralizeRu(22, forms)).toBe('раза');
  });
});
