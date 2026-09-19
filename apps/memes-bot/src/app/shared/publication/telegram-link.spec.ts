import {
  buildPostUrl,
  channelInternalId,
  escapeHtml,
} from './telegram-link';

describe('telegram-link', () => {
  describe('channelInternalId', () => {
    it('преобразует Bot API id канала (-100...) во внутренний id', () => {
      expect(channelInternalId(-1001234567890)).toBe('1234567890');
    });

    it('возвращает положительный (MTProto) id как есть', () => {
      expect(channelInternalId(1234567890)).toBe('1234567890');
    });

    it('корректно работает со строкой и bigint-подобным значением', () => {
      expect(channelInternalId('-1001234567890')).toBe('1234567890');
      expect(channelInternalId({ toString: () => '-1001234567890' })).toBe('1234567890');
    });

    it('обрезает префикс у нечислового значения', () => {
      expect(channelInternalId('-100abc')).toBe('abc');
    });
  });

  describe('buildPostUrl', () => {
    it('строит ссылку на пост по username', () => {
      expect(buildPostUrl({ id: -1001, username: 'channel' }, 42)).toBe(
        'https://t.me/channel/42'
      );
    });

    it('снимает @ и строит ссылку на канал без messageId', () => {
      expect(buildPostUrl({ username: '@channel' })).toBe('https://t.me/channel');
    });

    it('строит приватную ссылку t.me/c по id', () => {
      expect(buildPostUrl({ id: -1001234567890 }, 7)).toBe('https://t.me/c/1234567890/7');
    });

    it('возвращает null, если нет ни username, ни id', () => {
      expect(buildPostUrl({}, 1)).toBeNull();
    });
  });

  describe('escapeHtml', () => {
    it('экранирует спецсимволы', () => {
      expect(escapeHtml('a & b <i> "x"')).toBe('a &amp; b &lt;i&gt; &quot;x&quot;');
    });
  });
});
