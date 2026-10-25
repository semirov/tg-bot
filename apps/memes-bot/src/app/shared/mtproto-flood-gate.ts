/**
 * Общий на процесс стейт паузы MTProto по FloodWait.
 *
 * Вынесен из `ParserMtprotoGuard` в dependency-free singleton, потому что паузу
 * обязаны видеть обе стороны одного аккаунта: парсер (guard) и юзербот-наблюдатель
 * (`ClientBaseService`). Прямая зависимость client → parser дала бы цикл
 * (guard → ParserClientService → ClientBaseService), поэтому здесь нет ни DI,
 * ни импортов из модулей приложения.
 */
export class MtprotoFloodGate {
  /** Дедлайн активной паузы, epoch ms; 0 — паузы нет. */
  private untilMs = 0;

  /** Секунды текущего ожидания: такое же/меньшее ожидание паузу не продлевает. */
  private waitSeconds = 0;

  /**
   * Дедлайн активной паузы.
   *
   * @param now текущий момент (epoch ms), подменяется в тестах
   * @returns epoch ms дедлайна или `null`, если паузы нет (истёкшая сбрасывается)
   */
  public until(now: number = Date.now()): number | null {
    if (this.untilMs && this.untilMs <= now) this.reset();
    return this.untilMs > 0 ? this.untilMs : null;
  }

  /** Идёт ли сейчас пауза MTProto. */
  public isBlocked(now: number = Date.now()): boolean {
    return this.until(now) !== null;
  }

  /**
   * Регистрирует требование Telegram подождать.
   *
   * Пока пауза активна, повторный отчёт о том же (или меньшем) ожидании не
   * продлевает дедлайн и не считается новым — иначе повторные отчёты об одном
   * FloodWait сдвигали бы паузу бесконечно. Дедлайн дедуплицируется по
   * абсолютному значению ожидания, а не по временному окну.
   *
   * @param seconds сколько секунд просит Telegram
   * @param jitterMs добавка к дедлайну (разводит вызовы после паузы)
   * @param now текущий момент (epoch ms), подменяется в тестах
   * @returns новый дедлайн, если ожидание новое/длинее; иначе `null`
   */
  public block(seconds: number, jitterMs = 0, now: number = Date.now()): number | null {
    const active = this.until(now);
    if (active !== null && seconds <= this.waitSeconds) return null;

    this.waitSeconds = seconds;
    this.untilMs = now + seconds * 1000 + jitterMs;
    return this.untilMs;
  }

  /** Сбрасывает паузу (истёкший дедлайн, тесты). */
  public reset(): void {
    this.untilMs = 0;
    this.waitSeconds = 0;
  }
}

/** Процессный singleton: один аккаунт-юзербот — одна пауза. */
export const mtprotoFloodGate = new MtprotoFloodGate();
