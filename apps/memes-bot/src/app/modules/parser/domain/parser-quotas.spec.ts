import {
  buildDayCounters,
  cringeQuotaLeft,
  dailyLeft,
  dedupBatch,
  pickByFairness,
  QuotaRules,
} from './parser-quotas';

const rules: QuotaRules = { dailyLimit: 10, sourceDailyCap: 2, cringeShare: 0.25 };

describe('parser-quotas', () => {
  const startOfDay = new Date('2026-09-19T00:00:00Z');
  const at = (hour: number) => new Date(`2026-09-19T${String(hour).padStart(2, '0')}:00:00Z`);

  describe('buildDayCounters', () => {
    it('считает только сегодняшние доставки', () => {
      const counters = buildDayCounters(
        [
          { sourceChatId: 1, category: 'memes', cringe: false, at: at(5) },
          { sourceChatId: 1, category: 'memes', cringe: false, at: at(7) },
          { sourceChatId: 2, category: 'cringe', cringe: true, at: at(8) },
          { sourceChatId: 3, category: 'memes', cringe: false, at: new Date('2026-09-18T23:00:00Z') },
        ],
        startOfDay,
        (item) => item.at
      );
      expect(counters.total).toBe(3);
      expect(counters.cringe).toBe(1);
      expect(counters.perSource['1']).toBe(2);
      expect(counters.perSource['3']).toBeUndefined();
    });
  });

  describe('cringeQuotaLeft / dailyLeft', () => {
    it('считает остатки', () => {
      expect(dailyLeft(rules, { perSource: {}, cringe: 0, total: 3 })).toBe(7);
      expect(cringeQuotaLeft(rules, { perSource: {}, cringe: 2, total: 2 })).toBe(0);
      expect(cringeQuotaLeft(rules, { perSource: {}, cringe: 1, total: 1 })).toBe(1);
    });
  });

  describe('pickByFairness', () => {
    const candidate = (id: number, sourceChatId: number, score: number, category = 'memes') => ({
      id,
      sourceChatId,
      category,
      score,
      stage: 'final',
    });

    it('берёт лучшие по score в пределах лимита', () => {
      const picked = pickByFairness(
        [candidate(1, 10, 5), candidate(2, 20, 9), candidate(3, 30, 7)],
        rules,
        { perSource: {}, cringe: 0, total: 0 }
      );
      expect(picked).toEqual([2, 3, 1]);
    });

    it('не превышает общий дневной лимит', () => {
      const many = Array.from({ length: 15 }, (_, index) => candidate(index + 1, 100 + index, 5));
      const picked = pickByFairness(many, rules, { perSource: {}, cringe: 0, total: 0 });
      expect(picked.length).toBe(10);
    });

    it('не превышает кап на источник', () => {
      const fromOne = [
        candidate(1, 10, 9),
        candidate(2, 10, 8),
        candidate(3, 10, 7),
        candidate(4, 20, 6),
      ];
      const picked = pickByFairness(fromOne, rules, { perSource: {}, cringe: 0, total: 0 });
      expect(picked).toContain(1);
      expect(picked).toContain(2);
      expect(picked).not.toContain(3);
      expect(picked).toContain(4);
    });

    it('учитывает уже использованную квоту источника за сегодня', () => {
      const picked = pickByFairness([candidate(1, 10, 9), candidate(2, 10, 8)], rules, {
        perSource: { '10': 2 },
        cringe: 0,
        total: 2,
      });
      expect(picked).toEqual([]);
    });

    it('кринж не превышает долю от лимита', () => {
      const cringeMany = Array.from({ length: 5 }, (_, index) =>
        candidate(index + 1, 200 + index, 5, 'cringe')
      );
      const picked = pickByFairness(cringeMany, rules, { perSource: {}, cringe: 0, total: 0 });
      expect(picked.length).toBe(2); // floor(10 * 0.25)
    });

    it('мемы не залезают в кринж-квоту', () => {
      const mixed = [candidate(1, 10, 9, 'cringe'), candidate(2, 20, 8)];
      const picked = pickByFairness(mixed, rules, { perSource: {}, cringe: 0, total: 0 });
      expect(picked).toEqual([1, 2]);
    });

    it('лимит исчерпан → пусто', () => {
      const picked = pickByFairness([candidate(1, 10, 9)], rules, { perSource: {}, cringe: 0, total: 10 });
      expect(picked).toEqual([]);
    });
  });

  describe('безлимит и веса источников', () => {
    const unlimited: QuotaRules = { dailyLimit: 0, sourceDailyCap: 0, cringeShare: 0.25, selectLimit: 2 };
    const candidate = (id: number, sourceChatId: number, score: number, category = 'memes') => ({
      id,
      sourceChatId,
      category,
      score,
      stage: 'final',
    });

    it('dailyLimit=0 — темп прогона (selectLimit), а не суточный лимит', () => {
      expect(dailyLeft(unlimited, { perSource: {}, cringe: 0, total: 999 })).toBe(2);
      expect(cringeQuotaLeft(unlimited, { perSource: {}, cringe: 99, total: 99 })).toBe(2);
    });

    it('sourceDailyCap=0 — источник не ограничен по слотам', () => {
      const rows = [candidate(1, 10, 9), candidate(2, 10, 8), candidate(3, 10, 7)];
      expect(pickByFairness(rows, unlimited, { perSource: {}, cringe: 0, total: 0 })).toEqual([1, 2]);
    });

    it('вес источника поднимает кандидата выше более скорного', () => {
      const weighted: QuotaRules = {
        ...unlimited,
        selectLimit: 3,
        weights: { '20': 3 },
      };
      const rows = [candidate(1, 10, 10), candidate(2, 20, 5)];
      expect(pickByFairness(rows, weighted, { perSource: {}, cringe: 0, total: 0 })).toEqual([2, 1]);
    });

    it('без веса сохраняется порядок по score, затем по id', () => {
      const rows = [candidate(2, 30, 7), candidate(1, 30, 7)];
      expect(
        pickByFairness(rows, { ...unlimited, selectLimit: 5 }, { perSource: {}, cringe: 0, total: 0 })
      ).toEqual([1, 2]);
    });

    it('при равном весе-ранжировании решает score', () => {
      const weighted: QuotaRules = { ...unlimited, selectLimit: 5, weights: { '10': 2 } };
      const rows = [candidate(1, 10, 5), candidate(2, 20, 10)];
      // rank(1)=10, rank(2)=10 → тай-брейк по score (2 выше)
      expect(pickByFairness(rows, weighted, { perSource: {}, cringe: 0, total: 0 })).toEqual([2, 1]);
    });

    it('нулевой/отрицательный вес трактуется как 1', () => {
      const weighted: QuotaRules = { ...unlimited, selectLimit: 5, weights: { '20': 0 } };
      const rows = [candidate(1, 10, 5), candidate(2, 20, 5)];
      expect(pickByFairness(rows, weighted, { perSource: {}, cringe: 0, total: 0 })).toEqual([1, 2]);
    });
  });

  describe('dedupBatch', () => {
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
});
