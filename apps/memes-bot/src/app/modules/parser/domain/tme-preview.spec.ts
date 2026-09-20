import { estimatePostsPerDay, extractViewsFromBubble, fetchTmePreview, parseTmeHtml, parseTmeViews } from './tme-preview';
import axios from 'axios';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const bubble = (views: string, id: number, text: string, iso: string, withMedia = true) => `
  <div class="tgme_widget_message_wrap">
    <div class="tgme_widget_message" data-post="channel/${id}">
      ${withMedia ? '<a class="tgme_widget_message_photo_wrap" href="/channel/' + id + '"></a>' : ''}
      <div class="tgme_widget_message_text">${text}</div>
      <div class="tgme_widget_message_views"><span class="tgme_widget_message_views">${views}</span></div>
      <time datetime="${iso}"></time>
    </div>
  </div>`;

describe('tme-preview', () => {
  describe('parseTmeViews', () => {
    it.each([
      ['12.3K', 12300],
      ['1,2M', 1200000],
      ['847', 847],
      [null, 0],
      ['N/A', 0],
    ])('%s → %d', (raw, expected) => {
      expect(parseTmeViews(raw)).toBe(expected);
    });
  });

  describe('extractViewsFromBubble', () => {
    it('достаёт число из блока просмотров', () => {
      expect(extractViewsFromBubble('<span class="tgme_widget_message_views">4.5K</span>')).toBe(4500);
      expect(extractViewsFromBubble('<div>nothing</div>')).toBe(0);
    });
  });

  describe('parseTmeHtml', () => {
    it('разбирает посты, просмотры, медиа, текст и время', () => {
      const html = `<html><span class="tgme_widget_message_owner_name">Канал мемов</span>${bubble(
        '1.2K',
        101,
        'Смешной <b>мем</b>',
        '2026-09-19T10:00:00Z'
      )}${bubble('900', 102, 'Просто текст', '2026-09-19T12:00:00Z', false)}</html>`;

      const preview = parseTmeHtml(html, 'test_channel');

      expect(preview.username).toBe('test_channel');
      expect(preview.title).toBe('Канал мемов');
      expect(preview.posts).toHaveLength(2);
      expect(preview.posts[0]).toEqual({
        id: 101,
        views: 1200,
        hasMedia: true,
        text: 'Смешной мем',
        timeIso: '2026-09-19T10:00:00Z',
      });
      expect(preview.posts[1].hasMedia).toBe(false);
    });
  });

  describe('estimatePostsPerDay', () => {
    it('считает частоту по временным меткам', () => {
      const posts = [
        { id: 1, views: 1, hasMedia: true, text: '', timeIso: '2026-09-19T00:00:00Z' },
        { id: 2, views: 1, hasMedia: true, text: '', timeIso: '2026-09-19T12:00:00Z' },
      ];
      expect(estimatePostsPerDay(posts)).toBe(4);
    });

    it('мало данных → null', () => {
      expect(estimatePostsPerDay([])).toBeNull();
      expect(
        estimatePostsPerDay([{ id: 1, views: 1, hasMedia: true, text: '', timeIso: '2026-09-19T00:00:00Z' }])
      ).toBeNull();
    });
  });

  describe('fetchTmePreview', () => {
    it('парсит успешный ответ', async () => {
      (axios.get as jest.Mock).mockResolvedValue({
        data: bubble('500', 7, 'текст', '2026-09-19T10:00:00Z'),
      });
      const preview = await fetchTmePreview('good_channel');
      expect(preview?.posts).toHaveLength(1);
      expect(preview?.posts[0].views).toBe(500);
    });

    it('не-канальная страница → null', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: '<html>404</html>' });
      expect(await fetchTmePreview('nope')).toBeNull();
    });

    it('сетевая ошибка → null', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('boom'));
      expect(await fetchTmePreview('bad')).toBeNull();
    });
  });
});
