import { ObservatoryPostFormatter } from './observatory-post-formatter';
import { ObservatoryPostMenusEnum } from '../contsants/observatory-post-menus.enum';

describe('ObservatoryPostFormatter', () => {
  let formatter: ObservatoryPostFormatter;

  beforeEach(() => {
    formatter = new ObservatoryPostFormatter();
  });

  it('объявляет общие с post-management метки', () => {
    expect(ObservatoryPostFormatter.POST_MENU_LABEL).toBe('🤖 Пост обсерватории');
    expect(ObservatoryPostFormatter.PUBLISH_LABEL).toBe('Опубликовать');
    expect(ObservatoryPostFormatter.REJECT_LABEL).toBe('Отклонить');
    expect(ObservatoryPostFormatter.PUBLISH_NIGHT_CRINGE_LABEL).toBe('Кринж');
    expect(ObservatoryPostFormatter.PUBLISH_NOW_LABEL).toBe('Сейчас');
    expect(ObservatoryPostFormatter.PUBLISH_NEXT_INTERVAL_LABEL).toBe('Ближайший слот');
    expect(ObservatoryPostFormatter.PUBLISH_NIGHT_LABEL).toBe('Ночью');
    expect(ObservatoryPostFormatter.PUBLISH_MORNING_LABEL).toBe('Утром');
    expect(ObservatoryPostFormatter.PUBLISH_MIDDAY_LABEL).toBe('Днем');
    expect(ObservatoryPostFormatter.PUBLISH_EVENING_LABEL).toBe('Вечером');
    expect(ObservatoryPostFormatter.BACK_LABEL).toBe('Назад');
  });

  describe('composeCaption', () => {
    it('соединяет подпись и ссылку переводом строки', () => {
      expect(formatter.composeCaption('текст', '<a>канал</a>')).toBe('текст\n<a>канал</a>');
    });

    it('возвращает одну непустую часть', () => {
      expect(formatter.composeCaption('текст', null)).toBe('текст');
      expect(formatter.composeCaption(undefined, '<a>канал</a>')).toBe('<a>канал</a>');
    });

    it('возвращает пустую строку без частей', () => {
      expect(formatter.composeCaption(undefined, undefined)).toBe('');
      expect(formatter.composeCaption(null, null)).toBe('');
    });
  });

  describe('publishedKeyboard', () => {
    it('строит URL-кнопку с ником модератора', () => {
      expect(formatter.publishedLabel('moder')).toBe('🤖 Опубликован (moder)');

      const keyboard = formatter.publishedKeyboard('moder', 'https://channel');
      expect(keyboard.inline_keyboard[0][0].text).toBe('🤖 Опубликован (moder)');
      expect((keyboard.inline_keyboard[0][0] as any).url).toBe('https://channel');
    });
  });

  describe('scheduledKeyboard', () => {
    it('строит кнопку с датой и ником в общем формате', () => {
      const keyboard = formatter.scheduledKeyboard('18.09.26 в ~21:30', 'moder');
      expect(keyboard.inline_keyboard[0][0].text).toBe('⏰ 18.09.26 в ~21:30 (moder)');
    });
  });

  describe('rejectedKeyboard', () => {
    it('строит кнопку удаления отклонённого поста', () => {
      const keyboard = formatter.rejectedKeyboard('moder');
      expect(keyboard.inline_keyboard[0][0].text).toBe('🤖 Отклонен ❌ (moder)');
      expect((keyboard.inline_keyboard[0][0] as any).callback_data).toBe(
        ObservatoryPostMenusEnum.DELETE_OBSERVER_POST
      );
    });
  });

  describe('sourceCaption', () => {
    it('возвращает пустую строку без источника и без ссылки', () => {
      expect(formatter.sourceCaption(null)).toBe('');
      expect(formatter.sourceCaption(undefined)).toBe('');
      expect(formatter.sourceCaption({ url: '', title: 'канал' } as any)).toBe('');
    });

    it('строит ссылку с заголовком и экранирует HTML', () => {
      expect(
        formatter.sourceCaption({ url: 'https://t.me/c/1/2', title: 'A & <B>' } as any)
      ).toBe('🔎 Источник: <a href="https://t.me/c/1/2">A &amp; &lt;B&gt;</a>');
    });

    it('без заголовка берёт username, а без него — заглушку', () => {
      expect(
        formatter.sourceCaption({ url: 'https://t.me/c/1/2', username: 'chan' } as any)
      ).toContain('>chan<');
      expect(formatter.sourceCaption({ url: 'https://t.me/c/1/2' } as any)).toContain(
        '>исходный канал<'
      );
    });
  });

});
