import { parseLlmJson } from './llm-json';

interface Sample {
  years: number;
  articles: { code: string; years?: number; reason?: string }[];
  reason?: string;
}

describe('parseLlmJson', () => {
  it('парсит строгий JSON', () => {
    const raw = '{"years": 2, "articles": [{"code": "ст. 158 УК РФ", "years": 2}]}';

    expect(parseLlmJson<Sample>(raw)).toEqual({
      years: 2,
      articles: [{ code: 'ст. 158 УК РФ', years: 2 }],
    });
  });

  it('снимает markdown-обёртку ```json', () => {
    const raw = '```json\n{"years": 1, "articles": []}\n```';

    expect(parseLlmJson<Sample>(raw)).toEqual({ years: 1, articles: [] });
  });

  it('достаёт JSON из текста вокруг', () => {
    const raw = 'Вот результат:\n{"years": 5, "articles": []}\nГотово.';

    expect(parseLlmJson<Sample>(raw)).toEqual({ years: 5, articles: [] });
  });

  it('достраивает объект, обрезанный после завершённой строки', () => {
    // Реальный случай /stat: ответ оборвался по max_tokens на закрывающей кавычке,
    // без финальной "}".
    const raw = '{"years": 34, "articles": [{"code": "ст. 272 УК РФ", "years": 4}], "reason": "набежало прилично"';

    const parsed = parseLlmJson<Sample>(raw);

    expect(parsed).toEqual({
      years: 34,
      articles: [{ code: 'ст. 272 УК РФ', years: 4 }],
      reason: 'набежало прилично',
    });
  });

  it('достраивает объект, обрезанный внутри строки', () => {
    const raw = '{"years": 3, "articles": [], "reason": "договаривай уже';

    const parsed = parseLlmJson<Sample>(raw);

    expect(parsed).toEqual({ years: 3, articles: [], reason: 'договаривай уже' });
  });

  it('отбрасывает висящий ключ без значения', () => {
    const raw = '{"years": 3, "articles": [], "reason":';

    expect(parseLlmJson<Sample>(raw)).toEqual({ years: 3, articles: [] });
  });

  it('отбрасывает висящую запятую', () => {
    const raw = '{"years": 3, "articles": [],"reason": "ок",';

    expect(parseLlmJson<Sample>(raw)).toEqual({ years: 3, articles: [], reason: 'ок' });
  });

  it('закрывает обрезанный массив, спасая частичный элемент', () => {
    const raw = '{"years": 4, "articles": [{"code": "ст. 158 УК РФ", "years": 2}, {"code": "ст. 119';

    // Хвост объекта закрывается, а неполный элемент остаётся с тем, что успело
    // прийти: downstream-санитайзер заполнит или отбросит пустые поля.
    expect(parseLlmJson<Sample>(raw)).toEqual({
      years: 4,
      articles: [{ code: 'ст. 158 УК РФ', years: 2 }, { code: 'ст. 119' }],
    });
  });

  it('не путается на скобках внутри строк', () => {
    const raw = '{"years": 1, "articles": [], "reason": "скобки { } и \\"кавычки\\" — это текст"}';

    expect(parseLlmJson<Sample>(raw)).toEqual({
      years: 1,
      articles: [],
      reason: 'скобки { } и "кавычки" — это текст',
    });
  });

  it('возвращает null, если JSON нет', () => {
    expect(parseLlmJson('чёт я подвис, попробуй ещё раз')).toBeNull();
    expect(parseLlmJson('')).toBeNull();
    expect(parseLlmJson(null)).toBeNull();
    expect(parseLlmJson(undefined)).toBeNull();
  });
});
