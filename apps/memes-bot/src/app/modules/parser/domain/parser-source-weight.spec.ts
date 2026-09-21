import {
  COOLDOWN_DAYS,
  COOLDOWN_MIN_HARD,
  IGNORE_PENALTY_CAP,
  MIN_WEIGHT,
  PAUSE_WEIGHT,
  SOFT_IGNORE_PENALTY_STEP,
  TAKEN_HALF_LIFE_DAYS,
  WEIGHT_TAKEN_CAP,
  computeSourceInterest,
  computeSourceWeight,
  rankScore,
} from './parser-source-weight';

const NOW = new Date('2026-09-19T12:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

describe('parser-source-weight', () => {
  describe('computeSourceWeight', () => {
    it('стартовый вес 1 без взятых постов', () => {
      expect(computeSourceWeight(0)).toBe(1);
    });

    it('вес растёт логарифмически от takenTotal', () => {
      expect(computeSourceWeight(1)).toBeGreaterThan(1);
      expect(computeSourceWeight(3)).toBeGreaterThan(computeSourceWeight(1));
      expect(computeSourceWeight(10)).toBeLessThanOrEqual(1 + WEIGHT_TAKEN_CAP);
      expect(computeSourceWeight(1000)).toBe(1 + WEIGHT_TAKEN_CAP);
    });

    it('некорректные значения трактуются как 0', () => {
      expect(computeSourceWeight(Number.NaN)).toBe(1);
      expect(computeSourceWeight(-5)).toBe(1);
      expect(computeSourceWeight(2.9)).toBe(computeSourceWeight(2));
    });
  });

  describe('computeSourceInterest', () => {
    it('чистый источник: базовый вес без паузы', () => {
      const state = computeSourceInterest({ takenTotal: 0, ignoredTotal: 0 }, NOW);
      expect(state.weight).toBe(1);
      expect(state.cooldownUntil).toBeNull();
    });

    it('взятые посты поднимают вес, пока взятие свежее', () => {
      const state = computeSourceInterest({ takenTotal: 5, ignoredTotal: 0, lastTakenAt: NOW }, NOW);
      expect(state.weight).toBeGreaterThan(1);
    });

    it('без lastTakenAt положительный буст не применяется', () => {
      const state = computeSourceInterest({ takenTotal: 5, ignoredTotal: 0 }, NOW);
      expect(state.weight).toBe(1);
    });

    it('буст затухает вдвое за TAKEN_HALF_LIFE_DAYS', () => {
      const takenTotal = 5; // boost = min(WEIGHT_TAKEN_CAP, log2(6)) = 2
      const fresh = computeSourceInterest({ takenTotal, ignoredTotal: 0, lastTakenAt: NOW }, NOW);
      const half = computeSourceInterest(
        { takenTotal, ignoredTotal: 0, lastTakenAt: daysAgo(TAKEN_HALF_LIFE_DAYS) },
        NOW
      );
      const quarter = computeSourceInterest(
        { takenTotal, ignoredTotal: 0, lastTakenAt: daysAgo(TAKEN_HALF_LIFE_DAYS * 2) },
        NOW
      );

      expect(fresh.weight).toBeCloseTo(3, 5);
      expect(half.weight).toBeCloseTo(2, 5);
      expect(quarter.weight).toBeCloseTo(1.5, 5);
      expect(half.weight).toBeLessThan(fresh.weight);
      expect(quarter.weight).toBeLessThan(half.weight);
    });

    it('lastTakenAt принимает строку; мусорная дата = буста нет', () => {
      const asString = computeSourceInterest(
        { takenTotal: 5, ignoredTotal: 0, lastTakenAt: NOW.toISOString() },
        NOW
      );
      const invalid = computeSourceInterest(
        { takenTotal: 5, ignoredTotal: 0, lastTakenAt: 'не-дата' },
        NOW
      );
      expect(asString.weight).toBeCloseTo(3, 5);
      expect(invalid.weight).toBe(1);
    });

    it('жёсткий игнор в одиночку не включает паузу', () => {
      const state = computeSourceInterest({ takenTotal: 0, ignoredTotal: 1 }, NOW);
      expect(state.weight).toBeLessThan(1);
      expect(state.cooldownUntil).toBeNull();
    });

    it('мягкие игноры штрафуют слабее жёстких', () => {
      const hard = computeSourceInterest({ takenTotal: 0, ignoredTotal: 2 }, NOW);
      const soft = computeSourceInterest({ takenTotal: 0, ignoredTotal: 0, softIgnoredTotal: 2 }, NOW);
      expect(soft.weight).toBeGreaterThan(hard.weight);
      expect(soft.weight).toBeCloseTo(1 - 2 * SOFT_IGNORE_PENALTY_STEP, 5);
    });

    it('штраф ограничен IGNORE_PENALTY_CAP и вес не ниже MIN_WEIGHT', () => {
      const state = computeSourceInterest({ takenTotal: 0, ignoredTotal: 1000 }, NOW);
      expect(state.weight).toBeCloseTo(Math.max(MIN_WEIGHT, 1 - IGNORE_PENALTY_CAP), 5);
      expect(state.weight).toBeGreaterThanOrEqual(MIN_WEIGHT);
    });

    it('cooldown включается при >= COOLDOWN_MIN_HARD и весе ниже PAUSE_WEIGHT', () => {
      const boundary = computeSourceInterest({ takenTotal: 0, ignoredTotal: COOLDOWN_MIN_HARD }, NOW);
      expect(boundary.weight).toBeGreaterThan(PAUSE_WEIGHT);
      expect(boundary.cooldownUntil).toBeNull();

      const state = computeSourceInterest({ takenTotal: 0, ignoredTotal: 9 }, NOW);
      expect(state.weight).toBeLessThan(PAUSE_WEIGHT);
      expect(state.cooldownUntil).toEqual(new Date(NOW.getTime() + COOLDOWN_DAYS * 86_400_000));
    });

    it('cooldown не включается, если штраф тает', () => {
      const state = computeSourceInterest(
        { takenTotal: 0, ignoredTotal: COOLDOWN_MIN_HARD, lastIgnoredAt: daysAgo(30) },
        NOW
      );
      expect(state.weight).toBeCloseTo(1, 5);
      expect(state.cooldownUntil).toBeNull();
    });

    it('штраф частично тает за RECOVER_DAYS', () => {
      const fresh = computeSourceInterest({ takenTotal: 0, ignoredTotal: 4, lastIgnoredAt: NOW }, NOW);
      const old = computeSourceInterest(
        { takenTotal: 0, ignoredTotal: 4, lastIgnoredAt: daysAgo(3.5) },
        NOW
      );
      expect(old.weight).toBeGreaterThan(fresh.weight);
    });

    it('lastIgnoredAt принимает строку; мусорные даты игнорируются', () => {
      const asString = computeSourceInterest(
        { takenTotal: 0, ignoredTotal: 4, lastIgnoredAt: NOW.toISOString() },
        NOW
      );
      const invalid = computeSourceInterest(
        { takenTotal: 0, ignoredTotal: 4, lastIgnoredAt: 'не-дата' },
        NOW
      );
      expect(asString.weight).toBeLessThan(1);
      // мусорная дата = штраф без восстановления
      const fresh = computeSourceInterest({ takenTotal: 0, ignoredTotal: 4 }, NOW);
      expect(invalid.weight).toBeCloseTo(fresh.weight, 5);
    });

    it('now по умолчанию не ломает расчёт', () => {
      const state = computeSourceInterest({ takenTotal: 0, ignoredTotal: 0 });
      expect(state.weight).toBe(1);
      expect(state.cooldownUntil).toBeNull();
    });

    it('некорректные счётчики трактуются как 0', () => {
      const state = computeSourceInterest(
        { takenTotal: Number.NaN, ignoredTotal: Number.NaN, softIgnoredTotal: Number.NaN },
        NOW
      );
      expect(state.weight).toBe(1);
      expect(state.cooldownUntil).toBeNull();
    });
  });

  describe('rankScore', () => {
    it('умножает score на вес, дефолт 1', () => {
      expect(rankScore(10, 2)).toBe(20);
      expect(rankScore(10, undefined)).toBe(10);
      expect(rankScore(10, 0)).toBe(10);
      expect(rankScore(Number.NaN, 2)).toBe(0);
    });
  });
});
