import { dedupBatch } from './parser-quotas';

describe('parser-quotas.dedupBatch', () => {
  it('оставляет лучший по score на каждое медиа', () => {
    const picked = dedupBatch([
      { id: 1, score: 3, fileKey: 'photo-1' },
      { id: 2, score: 5, fileKey: 'photo-1' },
      { id: 3, score: 4, fileKey: 'photo-2' },
    ]);
    expect(picked).toEqual([2, 3]);
  });

  it('кандидаты без fileKey не дедупятся между собой', () => {
    const picked = dedupBatch([
      { id: 1, score: 3, fileKey: null },
      { id: 2, score: 4, fileKey: null },
    ]);
    expect(picked).toEqual([1, 2]);
  });
});
