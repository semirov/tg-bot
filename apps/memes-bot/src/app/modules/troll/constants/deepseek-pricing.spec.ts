import {
  DEEPSEEK_TARIFFS,
  estimateCostUsd,
  formatUsd,
  isDeepSeekPeak,
} from './deepseek-pricing';

/** Понедельник, 02:00 UTC — пиковое время. */
const PEAK_MONDAY = new Date('2026-09-14T02:00:00Z');
/** Понедельник, 05:00 UTC — между пиковыми окнами. */
const OFF_PEAK_MONDAY = new Date('2026-09-14T05:00:00Z');
/** Суббота, 02:00 UTC — выходной, всегда off-peak. */
const SATURDAY = new Date('2026-09-12T02:00:00Z');

const MILLION = 1_000_000;

describe('deepseek-pricing', () => {
  describe('isDeepSeekPeak', () => {
    it('считает пиковыми 01:00–04:00 и 06:00–10:00 UTC по будням', () => {
      expect(isDeepSeekPeak(new Date('2026-09-14T01:00:00Z'))).toBe(true);
      expect(isDeepSeekPeak(new Date('2026-09-14T03:59:00Z'))).toBe(true);
      expect(isDeepSeekPeak(new Date('2026-09-14T06:00:00Z'))).toBe(true);
      expect(isDeepSeekPeak(new Date('2026-09-14T09:59:00Z'))).toBe(true);
    });

    it('не считает пиковыми промежутки между окнами и после них', () => {
      expect(isDeepSeekPeak(new Date('2026-09-14T00:59:00Z'))).toBe(false);
      expect(isDeepSeekPeak(new Date('2026-09-14T04:00:00Z'))).toBe(false);
      expect(isDeepSeekPeak(new Date('2026-09-14T05:00:00Z'))).toBe(false);
      expect(isDeepSeekPeak(new Date('2026-09-14T10:00:00Z'))).toBe(false);
    });

    it('в выходные пикового тарифа нет', () => {
      expect(isDeepSeekPeak(SATURDAY)).toBe(false);
      expect(isDeepSeekPeak(new Date('2026-09-13T02:00:00Z'))).toBe(false);
    });

    it('без аргумента берёт текущее время', () => {
      expect(typeof isDeepSeekPeak()).toBe('boolean');
    });
  });

  describe('estimateCostUsd', () => {
    it('off-peak flash: вход мимо кэша + выход', () => {
      const cost = estimateCostUsd(
        'deepseek-flash',
        { promptTokens: MILLION, completionTokens: MILLION, cacheHitTokens: 0, cacheMissTokens: MILLION },
        { date: OFF_PEAK_MONDAY }
      );
      expect(cost).toBeCloseTo(0.15 + 0.6, 10);
    });

    it('peak flash вдвое дороже off-peak', () => {
      const usage = {
        promptTokens: MILLION,
        completionTokens: MILLION,
        cacheHitTokens: 0,
        cacheMissTokens: MILLION,
      };
      const peak = estimateCostUsd('deepseek-flash', usage, { date: PEAK_MONDAY });
      const offPeak = estimateCostUsd('deepseek-flash', usage, { date: OFF_PEAK_MONDAY });
      expect(peak).toBeCloseTo(offPeak * 2, 10);
    });

    it('кэшированный вход в разы дешевле', () => {
      const cached = estimateCostUsd(
        'deepseek-flash',
        { promptTokens: MILLION, completionTokens: 0, cacheHitTokens: MILLION, cacheMissTokens: 0 },
        { date: OFF_PEAK_MONDAY }
      );
      expect(cached).toBeCloseTo(DEEPSEEK_TARIFFS['deepseek-flash'].offPeak.cacheHitInput, 10);
      expect(cached).toBeLessThan(0.01);
    });

    it('без разбивки по кэшу считает вход как промах (дороже)', () => {
      const cost = estimateCostUsd(
        'deepseek-flash',
        { promptTokens: MILLION, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        { date: OFF_PEAK_MONDAY }
      );
      expect(cost).toBeCloseTo(0.15, 10);
    });

    it('неизвестная модель считается по тарифу flash', () => {
      const unknown = estimateCostUsd(
        'deepseek-unknown',
        { promptTokens: MILLION, completionTokens: MILLION, cacheHitTokens: 0, cacheMissTokens: MILLION },
        { date: OFF_PEAK_MONDAY }
      );
      expect(unknown).toBeCloseTo(0.75, 10);
    });

    it('свой тариф из настроек имеет приоритет', () => {
      const cost = estimateCostUsd(
        'deepseek-flash',
        { promptTokens: MILLION, completionTokens: MILLION, cacheHitTokens: 0, cacheMissTokens: MILLION },
        { date: PEAK_MONDAY, tariff: { cacheHitInput: 0, cacheMissInput: 1, output: 2 } }
      );
      expect(cost).toBeCloseTo(3, 10);
    });

    it('без опций берёт текущее время и табличный тариф', () => {
      const cost = estimateCostUsd('deepseek-flash', {
        promptTokens: MILLION,
        completionTokens: MILLION,
        cacheHitTokens: 0,
        cacheMissTokens: MILLION,
      });

      expect(cost).toBeGreaterThan(0);
    });

    it('мелкий запрос стоит доли цента', () => {
      const cost = estimateCostUsd(
        'deepseek-flash',
        { promptTokens: 3000, completionTokens: 200, cacheHitTokens: 0, cacheMissTokens: 3000 },
        { date: OFF_PEAK_MONDAY }
      );
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(0.001);
    });
  });

  describe('formatUsd', () => {
    it('крупные суммы — два знака', () => {
      expect(formatUsd(1.239)).toBe('$1.24');
    });

    it('мелкие суммы — четыре знака', () => {
      expect(formatUsd(0.01234)).toBe('$0.0123');
    });

    it('микроскопические суммы — пометка «меньше»', () => {
      expect(formatUsd(0.0000292)).toBe('< $0.0001');
      expect(formatUsd(0)).toBe('$0');
    });
  });
});
