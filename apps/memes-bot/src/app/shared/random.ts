/**
 * Токен внедрения зависимости для порта {@link Random}.
 */
export const RANDOM = Symbol('RANDOM');

/**
 * Порт источника случайных значений.
 *
 * Абстрагирует генератор случайных чисел, чтобы код можно было
 * детерминированно тестировать: в продакшене используется {@link SystemRandom},
 * а в тестах — подмена с предсказуемой последовательностью.
 */
export interface Random {
  /**
   * Возвращает случайное число в диапазоне `[0, 1)`.
   *
   * @returns дробное число от 0 включительно до 1 не включительно
   */
  next(): number;

  /**
   * Возвращает случайное целое число в диапазоне `[min, max]` включительно.
   *
   * @param min нижняя граница (включительно)
   * @param max верхняя граница (включительно)
   * @returns целое число от `min` до `max` включительно
   */
  int(min: number, max: number): number;

  /**
   * Выбирает случайный элемент непустого массива.
   *
   * @param items непустой массив элементов
   * @returns случайный элемент массива
   */
  pick<T>(items: readonly T[]): T;
}

/**
 * Реализация {@link Random} на базе `Math.random`.
 */
export class SystemRandom implements Random {
  /**
   * @inheritdoc
   */
  public next(): number {
    return Math.random();
  }

  /**
   * @inheritdoc
   */
  public int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * @inheritdoc
   */
  public pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
}
