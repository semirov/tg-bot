import { canonicalPeerKey, peerCacheKeys, peerLabel } from './parser-peer-key';

describe('parser-peer-key', () => {
  it('canonicalPeerKey сводит raw id, marked id и username к одной форме', () => {
    expect(canonicalPeerKey('8888888888')).toBe('-1008888888888');
    expect(canonicalPeerKey(8888888888)).toBe('-1008888888888');
    expect(canonicalPeerKey('-1008888888888')).toBe('-1008888888888');
    expect(canonicalPeerKey('-8888888888')).toBe('-1008888888888');
    expect(canonicalPeerKey('8888888888')).toBe(canonicalPeerKey('-1008888888888'));
    expect(canonicalPeerKey('@SomeChannel')).toBe('somechannel');
    expect(canonicalPeerKey('SomeChannel')).toBe('somechannel');
  });

  it('peerCacheKeys отдаёт формы ключей кэша gramjs', () => {
    expect(peerCacheKeys('-1008888888888')).toEqual([
      '-1008888888888',
      '8888888888',
      '-8888888888',
    ]);
    expect(peerCacheKeys('8888888888')).toEqual(peerCacheKeys('-1008888888888'));
    expect(peerCacheKeys('@SomeChannel')).toEqual(['somechannel']);
  });

  it('peerLabel маскирует username и не падает на пустом пире', () => {
    expect(peerLabel('-1008888888888')).toBe('-1008888888888');
    expect(peerLabel('SomeChannel')).toBe('<username>');
    expect(peerLabel(undefined)).toBe('-');
    expect(peerLabel(null)).toBe('-');
  });
});
