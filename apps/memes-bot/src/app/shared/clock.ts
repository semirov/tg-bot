/**
 * Токен внедрения зависимости для порта {@link Clock}.
 */
export const CLOCK = Symbol('CLOCK');

/**
 * Порт источника текущего времени.
 *
 * Абстрагирует системные часы, чтобы код можно было детерминированно
 * тестировать: в продакшене используется {@link SystemClock}, а в тестах —
 * подмена с фиксированным временем.
 */
export interface Clock {
  /**
   * Возвращает текущий момент времени.
   *
   * @returns новый объект `Date` с текущим моментом
   */
  now(): Date;

  /**
   * Возвращает текущий момент времени в миллисекундах с начала эпохи Unix.
   *
   * @returns число миллисекунд, прошедших с 1 января 1970 года UTC
   */
  timestamp(): number;
}

/**
 * Реализация {@link Clock} на системных часах.
 */
export class SystemClock implements Clock {
  /**
   * @inheritdoc
   */
  public now(): Date {
    return new Date();
  }

  /**
   * @inheritdoc
   */
  public timestamp(): number {
    return Date.now();
  }
}
