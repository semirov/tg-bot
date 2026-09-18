import { Random, RANDOM, SystemRandom } from './random';

describe('RANDOM', () => {
  it('является уникальным символом-токеном', () => {
    expect(typeof RANDOM).toBe('symbol');
    expect(RANDOM.toString()).toBe('Symbol(RANDOM)');
  });
});

describe('SystemRandom', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockRandom(value: number): jest.SpyInstance {
    return jest.spyOn(Math, 'random').mockReturnValue(value);
  }

  it('реализует порт Random', () => {
    const random: Random = new SystemRandom();
    expect(random).toBeInstanceOf(SystemRandom);
  });

  it('next() делегирует в Math.random', () => {
    const spy = mockRandom(0.42);
    const random = new SystemRandom();

    expect(random.next()).toBe(0.42);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('int() возвращает нижнюю границу при Math.random() === 0', () => {
    mockRandom(0);
    const random = new SystemRandom();

    expect(random.int(5, 10)).toBe(5);
  });

  it('int() возвращает верхнюю границу у максимального значения', () => {
    mockRandom(0.999999);
    const random = new SystemRandom();

    expect(random.int(5, 10)).toBe(10);
  });

  it('int() возвращает середину диапазона для среднего значения', () => {
    mockRandom(0.5);
    const random = new SystemRandom();

    expect(random.int(0, 9)).toBe(5);
    expect(random.int(1, 1)).toBe(1);
  });

  it('pick() выбирает элемент по индексу из int()', () => {
    mockRandom(0);
    const random = new SystemRandom();

    expect(random.pick(['a', 'b', 'c'])).toBe('a');

    mockRandom(0.999999);
    expect(random.pick(['a', 'b', 'c'])).toBe('c');
  });

  it('pick() работает с readonly-массивом любого типа', () => {
    mockRandom(0.5);
    const random = new SystemRandom();
    const items = [10, 20, 30] as const;

    expect(random.pick(items)).toBe(20);
  });
});
