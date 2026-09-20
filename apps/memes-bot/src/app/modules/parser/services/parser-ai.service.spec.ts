import { ParserAiService } from './parser-ai.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

const makeDeepseek = (): any => ({ completeJson: jest.fn().mockResolvedValue(null) });
const makeSettings = (aiEnabled = false): any => ({ current: { aiEnabled } });

describe('ParserAiService', () => {
  it('выключен (aiEnabled=false) → null/ложь без обращений', async () => {
    const deepseek = makeDeepseek();
    const ai = new ParserAiService(deepseek, makeSettings(false));

    expect(ai.enabled).toBe(false);
    expect(await ai.rejectPostIfTrash('реклама')).toBeNull();
    expect(await ai.isCringePost('кринж')).toBe(false);
    expect(await ai.classifyChannel('канал', ['текст'])).toBeNull();
    expect(deepseek.completeJson).not.toHaveBeenCalled();
  });

  it('пустая/короткая подпись не уходит в модель', async () => {
    const deepseek = makeDeepseek();
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.rejectPostIfTrash('ок')).toBeNull();
    expect(await ai.rejectPostIfTrash(null)).toBeNull();
    expect(deepseek.completeJson).not.toHaveBeenCalled();
  });

  it('реклама → ai:ad', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue({ isAd: true, nsfw: false, isCringe: false });
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.rejectPostIfTrash('Подпись с промо')).toBe('ai:ad');
  });

  it('nsfw → ai:nsfw', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue({ isAd: false, nsfw: true, isCringe: false });
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.rejectPostIfTrash('18+ подпись')).toBe('ai:nsfw');
  });

  it('чистый пост → null', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue({ isAd: false, nsfw: false, isCringe: false });
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.rejectPostIfTrash('нормальная подпись')).toBeNull();
  });

  it('неудача модели → null (не блокируем)', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue(null);
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.rejectPostIfTrash('подпись')).toBeNull();
  });

  it('classifyChannel: нормализация категории и релевантности', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue({ category: 'topical', relevance: 5, nsfw: false });
    const ai = new ParserAiService(deepseek, makeSettings(true));

    const verdict = await ai.classifyChannel('Новости', ['текст']);
    expect(verdict).toMatchObject({ category: 'topical', relevance: 1 });
  });

  it('classifyChannel: мусорный ответ → other/relevance 0', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue({ category: 'whatever', relevance: 'abc' });
    const ai = new ParserAiService(deepseek, makeSettings(true));

    const verdict = await ai.classifyChannel('Канал', []);
    expect(verdict).toMatchObject({ category: 'other', relevance: 0 });
  });

  it('isCringePost отражает вердикт', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue({ isCringe: true });
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.isCringePost('кринжовый пост')).toBe(true);
  });

  it('classifyChannel: null-ответ модели и пустой title', async () => {
    const deepseek = makeDeepseek();
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.classifyChannel(null, [])).toBeNull();

    deepseek.completeJson.mockResolvedValue({ category: 'memes', relevance: 0.9, nsfw: false });
    await ai.classifyChannel(null, ['текст']);
    expect(deepseek.completeJson.mock.calls[0][1]).toContain('(без названия)');
  });

  it('isCringePost: undefined-ответ модели → false', async () => {
    const deepseek = makeDeepseek();
    deepseek.completeJson.mockResolvedValue(undefined);
    const ai = new ParserAiService(deepseek, makeSettings(true));

    expect(await ai.isCringePost('кринж')).toBe(false);
  });
});
