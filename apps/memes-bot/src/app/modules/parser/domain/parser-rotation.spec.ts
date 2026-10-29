import {
  SWEEP_ACTIVE_MIN_INTERVAL_MS,
  SWEEP_WEB_ONLY_MIN_INTERVAL_MS,
  SourceStatus,
} from '../constants/parser.constants';
import { compareSweepOrder, compareStatsOrder, isSweepDue, sweepIntervalMs } from './parser-rotation';

const NOW = new Date('2026-10-29T09:00:00Z').getTime();
const hoursAgo = (hours: number): Date => new Date(NOW - hours * 3_600_000);

const src = (overrides: Record<string, unknown> = {}): any => ({
  id: 1,
  status: SourceStatus.ACTIVE,
  lastSweepAt: null,
  statsUpdatedAt: null,
  ...overrides,
});

describe('parser-rotation', () => {
  describe('sweepIntervalMs', () => {
    it('active — 4 ч, web_only — 24 ч', () => {
      expect(sweepIntervalMs(SourceStatus.ACTIVE)).toBe(SWEEP_ACTIVE_MIN_INTERVAL_MS);
      expect(sweepIntervalMs(SourceStatus.WEB_ONLY)).toBe(SWEEP_WEB_ONLY_MIN_INTERVAL_MS);
      expect(SWEEP_ACTIVE_MIN_INTERVAL_MS).toBe(4 * 3_600_000);
      expect(SWEEP_WEB_ONLY_MIN_INTERVAL_MS).toBe(24 * 3_600_000);
    });
  });

  describe('isSweepDue', () => {
    it('ни разу не свипали → пора', () => {
      expect(isSweepDue(src(), NOW)).toBe(true);
    });

    it('active: 3 ч назад — рано, 4 ч — пора', () => {
      expect(isSweepDue(src({ lastSweepAt: hoursAgo(3) }), NOW)).toBe(false);
      expect(isSweepDue(src({ lastSweepAt: hoursAgo(4) }), NOW)).toBe(true);
    });

    it('web_only: 4 ч назад — рано, 24 ч — пора', () => {
      expect(isSweepDue(src({ status: SourceStatus.WEB_ONLY, lastSweepAt: hoursAgo(4) }), NOW)).toBe(
        false
      );
      expect(
        isSweepDue(src({ status: SourceStatus.WEB_ONLY, lastSweepAt: hoursAgo(24) }), NOW)
      ).toBe(true);
    });

    it('метка строкой из БД и битая метка (как null)', () => {
      expect(isSweepDue(src({ lastSweepAt: hoursAgo(30).toISOString() }), NOW)).toBe(true);
      expect(isSweepDue(src({ lastSweepAt: 'not-a-date' }), NOW)).toBe(true);
    });
  });

  describe('compareSweepOrder', () => {
    it('active раньше web_only даже при более свежей метке', () => {
      const active = src({ id: 9, lastSweepAt: hoursAgo(3.9) });
      const webOnly = src({ id: 1, status: SourceStatus.WEB_ONLY, lastSweepAt: null });
      expect([webOnly, active].sort(compareSweepOrder).map((s) => s.id)).toEqual([9, 1]);
    });

    it('внутри статуса: lastSweepAt ASC, null первыми, tie-break id ASC', () => {
      const list = [
        src({ id: 5, lastSweepAt: hoursAgo(5) }),
        src({ id: 3, lastSweepAt: null }),
        src({ id: 4, lastSweepAt: hoursAgo(9) }),
        src({ id: 2, lastSweepAt: null }),
      ];
      expect(list.sort(compareSweepOrder).map((s) => s.id)).toEqual([2, 3, 4, 5]);
    });

    it('строковые метки сравниваются как даты', () => {
      const list = [
        src({ id: 1, lastSweepAt: hoursAgo(2).toISOString() }),
        src({ id: 2, lastSweepAt: hoursAgo(8).toISOString() }),
      ];
      expect(list.sort(compareSweepOrder).map((s) => s.id)).toEqual([2, 1]);
    });
  });

  describe('compareStatsOrder', () => {
    it('statsUpdatedAt ASC, null первыми, tie-break id ASC', () => {
      const list = [
        src({ id: 4, statsUpdatedAt: hoursAgo(1) }),
        src({ id: 3, statsUpdatedAt: null }),
        src({ id: 1, statsUpdatedAt: hoursAgo(30) }),
        src({ id: 2, statsUpdatedAt: null }),
      ];
      expect(list.sort(compareStatsOrder).map((s) => s.id)).toEqual([2, 3, 1, 4]);
    });

    it('status в порядке статистики не участвует', () => {
      const list = [
        src({ id: 7, status: SourceStatus.WEB_ONLY, statsUpdatedAt: null }),
        src({ id: 8, status: SourceStatus.ACTIVE, statsUpdatedAt: hoursAgo(5) }),
      ];
      expect(list.sort(compareStatsOrder).map((s) => s.id)).toEqual([7, 8]);
    });
  });
});
