import { Clock, CLOCK, SystemClock } from './clock';

describe('CLOCK', () => {
  it('является уникальным символом-токеном', () => {
    expect(typeof CLOCK).toBe('symbol');
    expect(CLOCK.toString()).toBe('Symbol(CLOCK)');
  });
});

describe('SystemClock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('реализует порт Clock', () => {
    const clock: Clock = new SystemClock();
    expect(clock).toBeInstanceOf(SystemClock);
  });

  it('now() возвращает текущее системное время', () => {
    const fixed = new Date('2026-07-15T12:34:56.789Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixed);

    const clock = new SystemClock();

    expect(clock.now()).toEqual(fixed);
    expect(clock.now()).toBeInstanceOf(Date);
  });

  it('timestamp() возвращает текущее время в миллисекундах', () => {
    const fixed = new Date('2026-07-15T12:34:56.789Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixed);

    const clock = new SystemClock();

    expect(clock.timestamp()).toBe(fixed.getTime());
  });

  it('при обычном ходе часов возвращает актуальные значения', () => {
    const before = Date.now();
    const clock = new SystemClock();

    const now = clock.now();
    const timestamp = clock.timestamp();

    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeGreaterThanOrEqual(timestamp - 1000);
    expect(now.getTime()).toBeLessThanOrEqual(timestamp + 1000);
  });
});
