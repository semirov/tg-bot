import { TROLL_VISION_MAX_CHARS } from '../constants/troll-limits';
import { renderImageDescription } from './troll-vision';

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
});
