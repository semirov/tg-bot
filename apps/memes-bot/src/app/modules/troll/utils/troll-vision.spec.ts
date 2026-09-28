import { TROLL_VISION_MAX_CHARS } from '../constants/troll-limits';
import { readImageConfidence, renderImageDescription } from './troll-vision';

describe('renderImageDescription', () => {
  it('разворачивает JSON-описание в одну строку с метками', () => {
    const raw = JSON.stringify({
      category: 'категория-а',
      subtype: 'подтип-б',
      summary: 'сводка один',
      people: ['персона один'],
      text: 'надпись на картинке',
      meme_template: 'шаблон-а',
      true_meaning: 'смысл-б',
      uncertain: ['деталь-в'],
    });

    const result = renderImageDescription(raw);

    expect(result).toContain('тип: категория-а / подтип-б');
    expect(result).toContain('что: сводка один');
    expect(result).toContain('люди: персона один');
    expect(result).toContain('мем-шаблон: шаблон-а');
    expect(result).toContain('истинный смысл: смысл-б');
    expect(result).toContain('неясно: деталь-в');
    expect(result).not.toContain('\n');
  });

  it('обходит markdown-обёртку вокруг JSON', () => {
    const raw = '```json\n{"category":"фото","summary":"кот"}\n```';
    const result = renderImageDescription(raw);
    expect(result).toContain('тип: фото');
    expect(result).toContain('что: кот');
  });

  it('не-JSON ответ сжимает в одну строку', () => {
    const result = renderImageDescription('  просто\n  текст  ');
    expect(result).toBe('просто текст');
  });

  it('обрезает описание по потолку', () => {
    const long = 'x'.repeat(TROLL_VISION_MAX_CHARS + 500);
    const result = renderImageDescription(JSON.stringify({ summary: long }));
    expect(result).not.toBeNull();
    expect((result as string).length).toBeLessThanOrEqual(TROLL_VISION_MAX_CHARS);
  });

  it('не разрывает слово при обрезке JSON-полей', () => {
    const raw = JSON.stringify({ summary: 'первое слово', scene: 'второе слово' });
    const result = renderImageDescription(raw, 25);
    expect(result).toBe('что: первое слово…');
    expect((result as string).length).toBeLessThanOrEqual(25);
  });

  it('не разрывает слово при обрезке не-JSON текста', () => {
    expect(renderImageDescription('альфа бета гамма дельта', 15)).toBe('альфа бета…');
  });

  it('ставит маркер только при обрезке', () => {
    expect(renderImageDescription('альфа бета', 50)).toBe('альфа бета');
    expect(renderImageDescription(JSON.stringify({ summary: 'кот' }), 50)).toBe('что: кот');

    const truncatedJson = renderImageDescription(JSON.stringify({ summary: 'кот' }), 4) as string;
    expect(truncatedJson.endsWith('…')).toBe(true);

    const truncatedPlain = renderImageDescription('альфа бета', 9) as string;
    expect(truncatedPlain.endsWith('…')).toBe(true);
  });

  it('граничные длины: ровно maxChars и maxChars-1 не обрезаются, maxChars+1 — обрезается', () => {
    const exact = 'a'.repeat(20);
    expect(renderImageDescription(exact, 20)).toBe(exact);

    const oneLess = 'a'.repeat(19);
    expect(renderImageDescription(oneLess, 20)).toBe(oneLess);

    const oneMore = renderImageDescription('a'.repeat(21), 20) as string;
    expect(oneMore.length).toBeLessThanOrEqual(20);
    expect(oneMore.endsWith('…')).toBe(true);

    const jsonExact = JSON.stringify({ summary: 'a'.repeat(20) });
    expect(renderImageDescription(jsonExact, 25)).toBe(`что: ${'a'.repeat(20)}`);
  });

  it('вырожденный случай: в бюджете нет пробелов — режет по символу', () => {
    expect(renderImageDescription('a'.repeat(10), 5)).toBe('aaaa…');

    const jsonResult = renderImageDescription(JSON.stringify({ summary: 'a'.repeat(20) }), 8) as string;
    expect(jsonResult.length).toBeLessThanOrEqual(8);
    expect(jsonResult.endsWith('…')).toBe(true);
  });

  it('при maxChars<=0 обрезка даёт null, а не пустую строку', () => {
    expect(renderImageDescription('слово', 0)).toBeNull();
    expect(renderImageDescription('слово', -5)).toBeNull();
    expect(renderImageDescription(JSON.stringify({ summary: 'слово' }), 0)).toBeNull();
  });

  it('возвращает null на пустом ответе', () => {
    expect(renderImageDescription('')).toBeNull();
    expect(renderImageDescription(null)).toBeNull();
    expect(renderImageDescription(JSON.stringify({}))).toBeNull();
  });

  it('не-JSON из одних пробелов даёт null', () => {
    expect(renderImageDescription('   \n  ')).toBeNull();
  });
});

describe('readImageConfidence', () => {
  it('достаёт уверенность из JSON и клампит в 0..1', () => {
    expect(readImageConfidence(JSON.stringify({ confidence: 0.8 }))).toBe(0.8);
    expect(readImageConfidence(JSON.stringify({ confidence: 1.7 }))).toBe(1);
    expect(readImageConfidence(JSON.stringify({ confidence: -2 }))).toBe(0);
  });

  it('возвращает 0 для пустого, не-JSON, отсутствия поля и мусора', () => {
    expect(readImageConfidence(null)).toBe(0);
    expect(readImageConfidence(undefined)).toBe(0);
    expect(readImageConfidence('')).toBe(0);
    expect(readImageConfidence('не json')).toBe(0);
    expect(readImageConfidence(JSON.stringify({}))).toBe(0);
    expect(readImageConfidence(JSON.stringify({ confidence: 'abc' }))).toBe(0);
  });
});
