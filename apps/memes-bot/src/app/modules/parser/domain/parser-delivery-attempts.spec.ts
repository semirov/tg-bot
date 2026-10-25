import { DELIVERY_ATTEMPT_LIMIT, DELIVERY_RETRY_BACKOFF_MS, ObservedStatus } from '../constants/parser.constants';
import {
  applyDeliveryFailure,
  classifyDeliveryFailure,
  isDeliveryBackedOff,
  mediaFailureReason,
} from './parser-delivery-attempts';

const NOW = new Date('2026-10-25T12:00:00Z');

const row = (overrides: Record<string, unknown> = {}): any => ({
  status: ObservedStatus.SELECTED,
  rejectReason: null,
  deliveryAttempts: null,
  lastDeliveryFailureAt: null,
  ...overrides,
});

describe('parser-delivery-attempts', () => {
  describe('classifyDeliveryFailure', () => {
    it('терминальные причины отклоняют сразу', () => {
      for (const reason of ['media-too-large', 'message-gone', 'source-missing']) {
        expect(classifyDeliveryFailure(reason)).toBe('terminal');
      }
    });

    it('медиа-сбои считаются попытками', () => {
      expect(classifyDeliveryFailure('media-fetch-failed')).toBe('attempt');
      expect(classifyDeliveryFailure('media-download-empty')).toBe('attempt');
    });

    it('сеть/флуд/неизвестное — транзиент (здоровый пост не приговариваем)', () => {
      for (const reason of ['network', 'flood-wait', 'mtproto-blocked', 'no-client', 'send-failed', null, undefined, '']) {
        expect(classifyDeliveryFailure(reason)).toBe('transient');
      }
    });
  });

  describe('mediaFailureReason', () => {
    it('вызова не было → пауза MTProto', () => {
      expect(mediaFailureReason(null)).toBe('mtproto-blocked');
    });

    it('флуд и сеть — транзиентные классы', () => {
      expect(mediaFailureReason(new Error('420: FLOOD_WAIT_60'))).toBe('flood-wait');
      expect(mediaFailureReason(new Error('A wait of 30 seconds is required'))).toBe('flood-wait');
      expect(mediaFailureReason(new Error('read ECONNRESET'))).toBe('network');
      expect(mediaFailureReason(new Error('socket hang up'))).toBe('network');
      expect(mediaFailureReason(new Error('RPCError: 503 SERVICE_UNAVAILABLE'))).toBe('network');
      expect(mediaFailureReason('TimeoutError: request timed out')).toBe('network');
    });

    it('протухшая ссылка на файл — медиа-сбой', () => {
      expect(mediaFailureReason(new Error('400: FILE_REFERENCE_EXPIRED'))).toBe('media-fetch-failed');
      expect(mediaFailureReason(new Error('CHANNEL_INVALID'))).toBe('media-fetch-failed');
    });
  });

  describe('applyDeliveryFailure', () => {
    it('терминальный сбой → REJECTED без траты попыток', () => {
      const candidate = row({ deliveryAttempts: 1 });
      expect(applyDeliveryFailure(candidate, 'media-too-large', NOW)).toEqual({
        rejected: true,
        attempts: 1,
      });
      expect(candidate).toMatchObject({
        status: ObservedStatus.REJECTED,
        rejectReason: 'media-too-large',
        deliveryAttempts: 1,
      });
    });

    it('медиа-сбой копит попытки и на пределе отклоняет', () => {
      const candidate = row();
      const first = applyDeliveryFailure(candidate, 'media-fetch-failed', NOW);
      expect(first).toEqual({ rejected: false, attempts: 1 });
      expect(candidate).toMatchObject({
        status: ObservedStatus.SCORED,
        rejectReason: null,
        lastDeliveryFailureAt: NOW,
      });

      applyDeliveryFailure(candidate, 'media-fetch-failed', NOW);
      const third = applyDeliveryFailure(candidate, 'media-fetch-failed', NOW);
      expect(third).toEqual({ rejected: true, attempts: DELIVERY_ATTEMPT_LIMIT });
      expect(candidate).toMatchObject({
        status: ObservedStatus.REJECTED,
        rejectReason: 'media-fetch-failed',
      });
    });

    it('транзиентный сбой возвращает в пул без попытки и ставит бэкофф', () => {
      const candidate = row({ deliveryAttempts: 2, rejectReason: 'flood-wait' });
      expect(applyDeliveryFailure(candidate, 'flood-wait', NOW)).toEqual({
        rejected: false,
        attempts: 2,
      });
      expect(candidate).toMatchObject({
        status: ObservedStatus.SCORED,
        rejectReason: null,
        deliveryAttempts: 2,
        lastDeliveryFailureAt: NOW,
      });
    });

    it('без причины сбой считается транзиентным', () => {
      const candidate = row({ rejectReason: 'media-too-large' });
      applyDeliveryFailure(candidate, null, NOW);
      expect(candidate.status).toBe(ObservedStatus.SCORED);
      expect(candidate.deliveryAttempts).toBeNull();
      expect(candidate.rejectReason).toBeNull();
    });
  });

  describe('isDeliveryBackedOff', () => {
    it('без провала или после окна — не в бэкоффе', () => {
      expect(isDeliveryBackedOff({ lastDeliveryFailureAt: null }, NOW)).toBe(false);
      expect(isDeliveryBackedOff({}, NOW)).toBe(false);
      expect(
        isDeliveryBackedOff(
          { lastDeliveryFailureAt: new Date(NOW.getTime() - DELIVERY_RETRY_BACKOFF_MS) },
          NOW
        )
      ).toBe(false);
    });

    it('свежий провал — в бэкоффе', () => {
      expect(
        isDeliveryBackedOff(
          { lastDeliveryFailureAt: new Date(NOW.getTime() - 60_000) },
          NOW
        )
      ).toBe(true);
    });
  });
});
