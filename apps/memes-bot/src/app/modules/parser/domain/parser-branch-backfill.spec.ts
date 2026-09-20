import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import {
  collectPostCrossLinks,
  extractCrossLinksFromText,
  normalizeChatId,
} from '../domain/parser-cross-links';
import { extractMediaInfo, rawIdOf } from '../domain/parser-media';
import {
  computeBaseline,
  computePostMetrics,
  countReactions,
  formatViews,
  parseViewCount,
  passesCringe,
  passesThresholds,
} from '../domain/parser-scoring';
import { dedupBatch } from '../domain/parser-quotas';
import { estimatePostsPerDay, parseTmeHtml, parseTmeViews } from '../domain/tme-preview';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) },
}));

describe('parser branch backfill (domain)', () => {
  it('normalizeChatId: уже ботовый id и граничные значения', () => {
    expect(normalizeChatId(-1_000_000_000_000)).toBe(-1_000_000_000_000);
    expect(normalizeChatId(-5)).toBe(-999999999995);
    expect(normalizeChatId(0)).toBe(-1_000_000_000_000);
  });

  it('rawIdOf: положительный chatId → abs', () => {
    expect(rawIdOf(-5)).toBe(5);
    expect(rawIdOf(7)).toBe(7);
    expect(rawIdOf(-1001234567890)).toBe(1234567890);
  });

  it('extractMediaInfo: photo без id и video без id → undefined', () => {
    const withEmptyPhoto = { video: undefined, photo: {} } as never;
    expect(extractMediaInfo(withEmptyPhoto)).toBeUndefined();
  });

  it('extractCrossLinksFromText: пустой username и joinchat', () => {
    expect(extractCrossLinksFromText('https://telegram.me/joinchat/AAAA')).toEqual([]);
    expect(extractCrossLinksFromText('https://t.me/joinchat')).toEqual([]);
    expect(extractCrossLinksFromText('мимо t.me/ но текст')).toEqual([]);
  });

  it('collectPostCrossLinks: fwd не PeerChannel → только ссылки', () => {
    const hits = collectPostCrossLinks(
      { message: 't.me/aaa', fwdFrom: {} as never },
      []
    );
    expect(hits).toEqual([{ username: 'aaa', chatId: null, origin: 'link' }]);
  });

  it('computeBaseline: NaN posShare отсекается', () => {
    const baseline = computeBaseline([{ views: 10, reactions: 1, posShare: Number.NaN }]);
    expect(baseline.posShare).toBe(0);
  });

  it('countReactions: нулевые счётчики пропускаются', () => {
    expect(countReactions([{ emoji: '🔥', count: 0 }])).toEqual({
      total: 0,
      positive: 0,
      negative: 0,
      cringe: 0,
    });
  });

  it('computePostMetrics: пустые реакции → posShare нейтрален', () => {
    const metrics = computePostMetrics(100, { total: 0, positive: 0, negative: 0, cringe: 0 }, {
      vmed: 10,
      rmed: 1,
      p90: 50,
      posShare: 1,
      sampleSize: 3,
    });
    expect(metrics.posShare).toBe(1);
    expect(metrics.cringeShare).toBe(0);
  });

  it('passesThresholds: p90 нулевой не даёт прохода', () => {
    const verdict = passesThresholds(
      1000,
      30,
      { nv: 1, nr: 1, rr: 0, posShare: 1, cringeShare: 0 },
      { minViews: 200, minReactions: 3, nvMin: 1.5, nrMin: 2, posShareMin: 0.25, hotScore: 4 },
      { vmed: 1000, rmed: 10, p90: 0, posShare: 1, sampleSize: 5 }
    );
    expect(verdict.passed).toBe(false);
  });

  it('parseViewCount/formatViews: крайние ветки', () => {
    expect(parseViewCount('12K3')).toBe(0);
    expect(parseViewCount('2.5m')).toBe(2_500_000);
    expect(formatViews(0)).toBe('0');
  });

  it('dedupBatch: равные score → остаётся первый', () => {
    expect(
      dedupBatch([
        { id: 1, score: 5, fileKey: 'k' },
        { id: 2, score: 5, fileKey: 'k' },
      ])
    ).toEqual([1]);
  });

  it('parseTmeHtml: без тайтла и без постов', () => {
    const preview = parseTmeHtml('<html><body>пусто</body></html>', 'empty');
    expect(preview.title).toBeNull();
    expect(preview.posts).toEqual([]);
  });

  it('parseTmeViews: пустая строка', () => {
    expect(parseTmeViews('')).toBe(0);
  });

  it('estimatePostsPerDay: нулевой интервал → null', () => {
    const iso = '2026-09-19T10:00:00Z';
    expect(
      estimatePostsPerDay([
        { id: 1, views: 1, hasMedia: true, text: '', timeIso: iso },
        { id: 2, views: 1, hasMedia: true, text: '', timeIso: iso },
      ])
    ).toBeNull();
  });

  it('Api.Photo/Document ветки extractMediaInfo через реальные объекты', () => {
    const photo = new Api.Photo({
      id: bigInt('111'),
      accessHash: bigInt('1'),
      fileReference: Buffer.from([]),
      date: 1,
      sizes: [],
      dcId: 2,
    });
    expect(extractMediaInfo({ photo, video: undefined } as never)).toEqual({
      kind: 'photo',
      uniqueId: '111',
    });
  });

  it('extractMediaInfo: null и видео', () => {
    expect(extractMediaInfo(null)).toBeUndefined();
    expect(extractMediaInfo(undefined)).toBeUndefined();
    const video = new Api.Document({
      id: bigInt('222'),
      accessHash: bigInt('1'),
      fileReference: Buffer.from([]),
      date: 1,
      attributes: [],
      mimeType: 'video/mp4',
      size: bigInt('10'),
      dcId: 2,
    });
    expect(extractMediaInfo({ video, photo: undefined } as never)).toEqual({
      kind: 'video',
      uniqueId: '222',
    });
  });

  it('parser-scoring: null/NaN ветки', () => {
    const baseline = { vmed: 1000, rmed: 10, p90: 4000, posShare: 0.8, sampleSize: 5 };
    const metrics = computePostMetrics(
      Number.NaN as never,
      countReactions([{ emoji: 'x', count: null as never }]),
      baseline
    );
    expect(metrics.nv).toBe(0);
    expect(metrics.posShare).toBe(1);

    expect(
      computePostMetrics(undefined as never, { total: 0, positive: 0, negative: 0, cringe: 0 }, baseline).nv
    ).toBe(0);

    const verdict = passesThresholds(
      null as never,
      null as never,
      metrics,
      { minViews: 200, minReactions: 3, nvMin: 1.5, nrMin: 2, posShareMin: 0.25, hotScore: 4 },
      baseline
    );
    expect(verdict.passed).toBe(false);

    expect(
      passesCringe(null as never, { nv: 0, nr: 0, rr: 0, posShare: 1, cringeShare: 0 }, 50, 0.05).passed
    ).toBe(false);
    expect(parseViewCount('.')).toBe(0);
    expect(formatViews(null as never)).toBe('0');
  });
});
