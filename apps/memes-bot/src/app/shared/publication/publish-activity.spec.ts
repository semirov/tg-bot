import {
  describePublishActivity,
  isPublishInFlight,
  markPublishEnd,
  markPublishStart,
  publishActivityState,
  resetPublishActivity,
  trackPublishActivity,
} from './publish-activity';

describe('publish-activity', () => {
  beforeEach(() => resetPublishActivity());

  it('пустое состояние описывается как idle', () => {
    expect(describePublishActivity(1000)).toBe('idle');
    expect(isPublishInFlight()).toBe(false);
    expect(publishActivityState()).toEqual({
      inFlightSinceMs: null,
      card: null,
      lastFinishedAtMs: null,
      lastOutcome: null,
    });
  });

  it('публикация в полёте: возраст и card', () => {
    markPublishStart(12345, 1000);
    expect(isPublishInFlight()).toBe(true);
    expect(describePublishActivity(13_345)).toBe('in_flight_for_ms=12345 card=12345');
    expect(publishActivityState().card).toBe(12345);
  });

  it('без card строка остаётся без идентификатора', () => {
    markPublishStart(undefined, 1000);
    expect(describePublishActivity(2000)).toBe('in_flight_for_ms=1000');
  });

  it('успешное завершение фиксирует исход и время', () => {
    markPublishStart(1, 1000);
    markPublishEnd(true, 2500);
    expect(isPublishInFlight()).toBe(false);
    expect(describePublishActivity(10_000)).toBe('idle last_outcome=ok last_finished_ago_ms=7500');
  });

  it('ошибка завершения фиксируется как error', () => {
    markPublishStart(1, 0);
    markPublishEnd(false, 500);
    expect(describePublishActivity(1500)).toBe('idle last_outcome=error last_finished_ago_ms=1000');
  });

  it('предыдущий исход виден, пока идёт новая публикация', () => {
    markPublishStart(1, 0);
    markPublishEnd(true, 1000);
    markPublishStart(2, 2000);
    expect(describePublishActivity(5000)).toBe(
      'in_flight_for_ms=3000 card=2 last_outcome=ok last_finished_ago_ms=4000'
    );
  });

  it.each([
    [true, 'ok'],
    [false, 'error'],
  ])('trackPublishActivity снимает маркер после завершения (ok=%s)', async (ok, outcome) => {
    const run = ok
      ? jest.fn().mockResolvedValue('done')
      : jest.fn().mockRejectedValue(new Error('boom'));

    const promise = trackPublishActivity(777, run);
    expect(isPublishInFlight()).toBe(true);
    expect(publishActivityState().card).toBe(777);

    if (ok) {
      await expect(promise).resolves.toBe('done');
    } else {
      await expect(promise).rejects.toThrow('boom');
    }
    expect(isPublishInFlight()).toBe(false);
    expect(publishActivityState().lastOutcome).toBe(outcome);
  });

  it('trackPublishActivity возвращает значение обработчика', async () => {
    await expect(trackPublishActivity(5, async () => 42)).resolves.toBe(42);
  });

  it('в лог попадают только числа и ключи — никаких имён', () => {
    markPublishStart(60, 0);
    expect(describePublishActivity(60_000)).toMatch(/^[a-z0-9_= ]+$/);
    markPublishEnd(true, 60_000);
    expect(describePublishActivity(61_000)).toMatch(/^[a-z0-9_= ]+$/);
  });

  it('состояние — копия, трекер снаружи не мутируется', () => {
    markPublishStart(10, 10);
    const snapshot = publishActivityState();
    snapshot.inFlightSinceMs = 999;
    expect(publishActivityState().inFlightSinceMs).toBe(10);
  });

  it('работает на системных часах по умолчанию', () => {
    markPublishStart(1);
    expect(describePublishActivity()).toMatch(/^in_flight_for_ms=\d+ card=1$/);
    markPublishEnd(true);
    expect(describePublishActivity()).toMatch(/^idle last_outcome=ok last_finished_ago_ms=\d+$/);
  });
});
