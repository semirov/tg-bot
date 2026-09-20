import {
  ChannelBaseline,
  computeBaseline,
  computePostMetrics,
  computeScore,
  countReactions,
  formatViews,
  isHotEnough,
  median,
  parseViewCount,
  passesCringe,
  passesThresholds,
  stageForAge,
} from './parser-scoring';
import { EvalStage } from '../constants/parser.constants';

const baseline = (overrides: Partial<ChannelBaseline> = {}): ChannelBaseline => ({
  vmed: 1000,
  rmed: 10,
  p90: 4000,
  posShare: 0.8,
  sampleSize: 30,
  ...overrides,
});

const rules = {
  minViews: 200,
  minReactions: 3,
  nvMin: 1.5,
  nrMin: 2,
  posShareMin: 0.25,
  hotScore: 4,
};

describe('parser-scoring', () => {
  describe('median', () => {
    it('возвращает медиану (нечёт/чёт)', () => {
      expect(median([5, 1, 3])).toBe(3);
      expect(median([4, 1, 3, 2])).toBe(2.5);
    });

    it('пустой список → 0', () => {
      expect(median([])).toBe(0);
    });
  });

  describe('computeBaseline', () => {
    it('считает медианы, p90 и долю положительных', () => {
      const result = computeBaseline([
        { views: 1000, reactions: 10, posShare: 0.9 },
        { views: 2000, reactions: 20, posShare: 0.8 },
        { views: 4000, reactions: 30, posShare: 0.7 },
        { views: 8000, reactions: 40, posShare: 0.6 },
      ]);

      expect(result.vmed).toBe(3000);
      expect(result.rmed).toBe(25);
      expect(result.p90).toBe(8000);
      expect(result.posShare).toBeCloseTo(0.75);
      expect(result.sampleSize).toBe(4);
    });

    it('пустой список → нули', () => {
      const result = computeBaseline([]);
      expect(result).toMatchObject({ vmed: 0, rmed: 0, p90: 0, posShare: 0, sampleSize: 0 });
    });
  });

  describe('countReactions', () => {
    it('классифицирует положительные/отрицательные/кринж', () => {
      const counts = countReactions([
        { emoji: '🔥', count: 10 },
        { emoji: '🤡', count: 4 },
        { emoji: '👎', count: 1 },
        { emoji: '🎈', count: 2 },
        { emoji: '🔥', count: -3 },
      ]);
      expect(counts).toEqual({ total: 17, positive: 10, negative: 1, cringe: 4 });
    });

    it('undefined → нули', () => {
      expect(countReactions(undefined)).toEqual({ total: 0, positive: 0, negative: 0, cringe: 0 });
    });
  });

  describe('computePostMetrics', () => {
    it('нормирует относительно базлайна', () => {
      const metrics = computePostMetrics(
        2000,
        { total: 30, positive: 24, negative: 2, cringe: 4 },
        baseline()
      );
      expect(metrics.nv).toBeCloseTo(2);
      expect(metrics.nr).toBeCloseTo(3);
      expect(metrics.rr).toBeCloseTo(0.015);
      // posShare = positive / (positive+negative) = 24/26
      expect(metrics.posShare).toBeCloseTo(24 / 26);
      expect(metrics.cringeShare).toBeCloseTo(2 / 15);
    });

    it('нулевой базлайн не даёт деления на ноль; нет распознанных реакций → posShare нейтрален', () => {
      const metrics = computePostMetrics(0, { total: 0, positive: 0, negative: 0, cringe: 0 }, baseline({ vmed: 0, rmed: 0 }));
      expect(metrics.nv).toBe(0);
      expect(metrics.nr).toBe(0);
      expect(metrics.posShare).toBe(1);
    });
  });

  describe('ограничения нормировки', () => {
    it('nv/nr ограничены сверху (NV_CAP/NR_CAP)', () => {
      const metrics = computePostMetrics(
        100000,
        { total: 1000, positive: 1000, negative: 0, cringe: 0 },
        baseline({ vmed: 100, rmed: 1 })
      );
      expect(metrics.nv).toBe(10);
      expect(metrics.nr).toBe(10);
      expect(computeScore(metrics)).toBe(20);
    });

    it('медиана реакций имеет пол (RMED_FLOOR=3)', () => {
      const metrics = computePostMetrics(
        1000,
        { total: 30, positive: 30, negative: 0, cringe: 0 },
        baseline({ vmed: 1000, rmed: 0 })
      );
      // 30 / max(3, 0) = 10 (кап), а не 30
      expect(metrics.nr).toBe(10);
    });

    it('posShare считается по распознанным реакциям: кастомные нейтральны', () => {
      const metrics = computePostMetrics(
        1000,
        { total: 50, positive: 10, negative: 0, cringe: 0 },
        baseline()
      );
      // 40 кастомных реакций не штрафуют: 10 положительных из 10 распознанных
      expect(metrics.posShare).toBe(1);
    });
  });

  describe('computeScore', () => {
    it('сумма nv+nr', () => {
      expect(computeScore({ nv: 2, nr: 3, rr: 0, posShare: 1, cringeShare: 0 })).toBe(5);
    });
  });

  describe('passesThresholds', () => {
    const good = { nv: 2, nr: 3, rr: 0.1, posShare: 0.9, cringeShare: 0 };

    it('проходит при выполнении всех порогов', () => {
      const verdict = passesThresholds(2000, 30, good, rules, baseline());
      expect(verdict.passed).toBe(true);
      expect(verdict.reasons).toEqual([]);
    });

    it('не проходит по абсолютному полу просмотров', () => {
      const verdict = passesThresholds(100, 30, good, rules, baseline());
      expect(verdict.passed).toBe(false);
      expect(verdict.reasons).toContain('views<200');
    });

    it('не проходит по реакциям', () => {
      const verdict = passesThresholds(2000, 2, { ...good, nr: 0.2 }, rules, baseline());
      expect(verdict.passed).toBe(false);
      expect(verdict.reasons).toContain('reactions<3');
    });

    it('не проходит без относительного превосходства', () => {
      const verdict = passesThresholds(1000, 30, { ...good, nv: 1, nr: 1 }, rules, baseline());
      expect(verdict.passed).toBe(false);
      expect(verdict.reasons).toContain('nv<1.5,nr<2,views<p90');
    });

    it('проходит по p90 даже без nv/nr', () => {
      const verdict = passesThresholds(4000, 30, { ...good, nv: 1, nr: 1 }, rules, baseline());
      expect(verdict.passed).toBe(true);
    });

    it('не проходит по posShare', () => {
      const verdict = passesThresholds(2000, 30, { ...good, posShare: 0.1 }, rules, baseline());
      expect(verdict.passed).toBe(false);
      expect(verdict.reasons).toContain('posShare<0.25');
    });
  });

  describe('passesCringe', () => {
    const cringe = { nv: 1, nr: 1, rr: 0, posShare: 0.2, cringeShare: 0.3 };

    it('проходит при достаточной доле 🤡/💩', () => {
      expect(passesCringe(200, cringe, 100, 0.12).passed).toBe(true);
    });

    it('не проходит по просмотрам', () => {
      expect(passesCringe(50, cringe, 100, 0.12).reasons).toContain('views<100');
    });

    it('не проходит по доле кринж-реакций', () => {
      const verdict = passesCringe(200, { ...cringe, cringeShare: 0.05 }, 100, 0.12);
      expect(verdict.reasons).toContain('cringeShare<0.12');
    });
  });

  describe('isHotEnough', () => {
    it('score >= hotScore → hot', () => {
      expect(isHotEnough({ nv: 3, nr: 2, rr: 0, posShare: 1, cringeShare: 0 }, rules)).toBe(true);
      expect(isHotEnough({ nv: 2, nr: 1, rr: 0, posShare: 1, cringeShare: 0 }, rules)).toBe(false);
    });
  });

  describe('stageForAge', () => {
    it('рано → null; 2ч → PRE; 12ч → FINAL', () => {
      expect(stageForAge(1 * 3_600_000, 2, 12)).toBeNull();
      expect(stageForAge(2 * 3_600_000, 2, 12)).toBe(EvalStage.PRE);
      expect(stageForAge(13 * 3_600_000, 2, 12)).toBe(EvalStage.FINAL);
    });
  });

  describe('parseViewCount / formatViews', () => {
    it.each([
      ['12.3K', 12300],
      ['1,2M', 1200000],
      ['847', 847],
      ['847', 847],
      ['', 0],
      [undefined, 0],
      ['abc', 0],
    ])('parseViewCount(%s) → %d', (raw, expected) => {
      expect(parseViewCount(raw)).toBe(expected);
    });

    it('formatViews форматирует', () => {
      expect(formatViews(847)).toBe('847');
      expect(formatViews(12345)).toBe('12.3K');
      expect(formatViews(1_500_000)).toBe('1.5M');
    });
  });
});
