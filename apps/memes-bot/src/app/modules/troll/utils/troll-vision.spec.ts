import { TROLL_VISION_MAX_CHARS } from '../constants/troll-limits';
import { readImageConfidence, renderImageDescription } from './troll-vision';

describe('renderImageDescription', () => {
  it('разворачивает JSON-описание в одну строку с метками', () => {
    const raw = JSON.stringify({
      category: 'мем',
      subtype: 'двухпанельный мем',
      summary: 'скрин уведомления и кадр с ухмылкой',
      people: ['мужчина в смокинге'],
      text: 'Я ВАМ КВАРТИРУ БЕЗ ЧЕРКАШЕЙ СДАВАЛА',
      meme_template: 'Джеймс Бонд с телефоном',
      true_meaning: 'шутка про претензию хозяйки',
      uncertain: ['точный актёр'],
    });

    const result = renderImageDescription(raw);

    expect(result).toContain('тип: мем / двухпанельный мем');
    expect(result).toContain('что: скрин уведомления и кадр с ухмылкой');
    expect(result).toContain('люди: мужчина в смокинге');
    expect(result).toContain('мем-шаблон: Джеймс Бонд с телефоном');
    expect(result).toContain('истинный смысл: шутка про претензию хозяйки');
    expect(result).toContain('неясно: точный актёр');
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
