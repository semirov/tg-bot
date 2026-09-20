import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { collectPostCrossLinks, extractCrossLinksFromText, fwdChatId, normalizeChatId } from './parser-cross-links';

const peerChannel = (channelId: number) =>
  new Api.PeerChannel({ channelId: bigInt(channelId) });

describe('parser-cross-links', () => {
  describe('normalizeChatId', () => {
    it('channelId MTProto → ботовый chatId', () => {
      expect(normalizeChatId(1234567890)).toBe(-1001234567890);
    });

    it('ботовый chatId не трогает', () => {
      expect(normalizeChatId(-1001234567890)).toBe(-1001234567890);
    });
  });

  describe('extractCrossLinksFromText', () => {
    it.each([
      ['t.me/some_meme', ['some_meme']],
      ['https://t.me/some_meme/123', ['some_meme']],
      ['https://telegram.me/FooBar', ['foobar']],
      ['tg://resolve?domain=channel_x', ['channel_x']],
      ['смотри t.me/aaa и t.me/BBB', ['aaa', 'bbb']],
      ['t.me/c/1234567890/12', []],
      ['t.me/+secretHash', []],
      ['t.me/joinchat/AAAA', []],
    ])('%s → %j', (text, expected) => {
      const hits = extractCrossLinksFromText(text);
      expect(hits.map((hit) => hit.username).filter(Boolean).sort()).toEqual(expected.sort());
    });

    it('t.me/c/<internal> даёт chatId', () => {
      const hits = extractCrossLinksFromText('https://t.me/c/1234567890/12');
      expect(hits).toEqual([{ username: null, chatId: -1001234567890, origin: 'link' }]);
    });

    it('дубликаты схлопываются', () => {
      const hits = extractCrossLinksFromText('t.me/dup t.me/dup t.me/DUP');
      expect(hits).toHaveLength(1);
    });

    it('пустой текст → пусто', () => {
      expect(extractCrossLinksFromText(null)).toEqual([]);
      expect(extractCrossLinksFromText('')).toEqual([]);
    });
  });

  describe('fwdChatId', () => {
    it('PeerChannel → нормализованный chatId', () => {
      const fwdFrom = { fromId: peerChannel(1234567890) } as never;
      expect(fwdChatId(fwdFrom)).toBe(-1001234567890);
    });

    it('нет forward → null', () => {
      expect(fwdChatId(null)).toBeNull();
      expect(fwdChatId({} as never)).toBeNull();
      expect(fwdChatId({ fromId: new Api.PeerUser({ userId: bigInt(42) }) } as never)).toBeNull();
    });
  });

  describe('collectPostCrossLinks', () => {
    it('fwd-источник + t.me-ссылки из текста', () => {
      const hits = collectPostCrossLinks(
        { message: 'оригинал: t.me/source_a', fwdFrom: { fromId: peerChannel(1111) } as never },
        []
      );
      expect(hits).toEqual([
        { username: null, chatId: -1000000001111, origin: 'fwd' },
        { username: 'source_a', chatId: null, origin: 'link' },
      ]);
    });

    it('свой fwd-источник отбрасывается, ссылка остаётся (фильтр username — на discovery)', () => {
      const hits = collectPostCrossLinks(
        { message: 't.me/other_channel', fwdFrom: { fromId: peerChannel(2222) } as never },
        [-1000000002222]
      );
      expect(hits).toEqual([{ username: 'other_channel', chatId: null, origin: 'link' }]);
    });
  });
});
