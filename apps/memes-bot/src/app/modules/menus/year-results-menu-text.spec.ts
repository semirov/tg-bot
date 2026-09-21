import { YearResultsMenuText } from './year-results-menu-text';

describe('YearResultsMenuText', () => {
  let text: YearResultsMenuText;

  beforeEach(() => {
    text = new YearResultsMenuText();
  });

  it('formatUserName делегирует в shared/display-name', () => {
    expect(text.formatUserName({ username: 'alpha' })).toBe('@alpha');
    expect(text.formatUserName({ firstName: 'Иван', lastName: 'Петров' })).toBe('Иван Петров');
    expect(text.formatUserName({ firstName: 'Иван', lastName: null })).toBe('Иван');
    expect(text.formatUserName({})).toBe('');
  });

  it('limitButtonLabel склоняет слово «час»', () => {
    expect(text.limitButtonLabel(1)).toBe('Снять лимит на 1 час');
    expect(text.limitButtonLabel(24)).toBe('Снять лимит на 24 часа');
    expect(text.limitButtonLabel(5)).toBe('Снять лимит на 5 часов');
  });

  it('limitRemovedMessage склоняет слово «час»', () => {
    expect(text.limitRemovedMessage(1)).toBe('Лимит мемов снят для пользователя на 1 час');
    expect(text.limitRemovedMessage(24)).toBe(
      'Лимит мемов снят для пользователя на 24 часа'
    );
  });

  it('возвращает тексты статуса генерации', () => {
    expect(text.generating()).toBe('Генерирую итоги года...');
    expect(text.generalPreviewHeader()).toBe(
      '<b>📊 Предпросмотр общей статистики для канала:</b>\n\n'
    );
    expect(text.generationError()).toBe('Произошла ошибка при генерации итогов года');
    expect(text.publishHint()).toBe(
      'Для публикации итогов используйте команду 📊 Итоги года → 🚀 Опубликовать'
    );
  });

  it('personalListHeader подставляет количество', () => {
    expect(text.personalListHeader(3)).toBe(
      '<b>📨 Персональные сообщения (3):</b>\n\nИспользуйте кнопки для навигации'
    );
  });

  it('userPreviewText подставляет имя и сообщение', () => {
    expect(text.userPreviewText({ username: 'alpha' }, 'PERSONAL')).toBe(
      '<b>📨 Предпросмотр сообщения для @alpha:</b>\n\nPERSONAL'
    );
  });

  describe('navigation', () => {
    it('первый из трёх: без кнопки «назад», со «вперёд»', () => {
      expect(text.navigation(0, 3)).toEqual({
        previous: undefined,
        counter: '1/3',
        next: 'Следующий ➡️',
      });
    });

    it('в середине: обе кнопки', () => {
      expect(text.navigation(1, 3)).toEqual({
        previous: '⬅️ Предыдущий',
        counter: '2/3',
        next: 'Следующий ➡️',
      });
    });

    it('последний: без кнопки «вперёд»', () => {
      expect(text.navigation(2, 3)).toEqual({
        previous: '⬅️ Предыдущий',
        counter: '3/3',
        next: undefined,
      });
    });

    it('единственный: только счётчик', () => {
      expect(text.navigation(0, 1)).toEqual({
        previous: undefined,
        counter: '1/1',
        next: undefined,
      });
    });
  });

  it('возвращает тексты статуса публикации', () => {
    expect(text.publishing()).toBe('Публикую итоги года...');
    expect(text.generalPublished()).toBe('✅ Общая статистика опубликована в канал');
    expect(text.personalPublished()).toBe('✅ Персональная статистика отправлена пользователям');
    expect(text.published()).toBe('🎉 Итоги года успешно опубликованы!');
    expect(text.publishError()).toBe('Произошла ошибка при публикации итогов года');
  });
});
