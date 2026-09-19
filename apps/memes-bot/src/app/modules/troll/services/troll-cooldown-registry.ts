import { Clock, SystemClock } from '../../../shared/clock';

/**
 * Реестр кулдаунов тролля.
 *
 * Хранит время последнего события по каждому «поводу» (анализ УК, сарказм,
 * кривляние, реакции, /stat, ответ на кличку, /meme) и отвечает на вопрос,
 * прошло ли достаточно времени. Текущее время берётся из порта {@link Clock},
 * чтобы логику можно было детерминированно тестировать.
 *
 * Карты доступны как публичные `readonly`-поля для совместимости с обращением
 * из `TrollService` (и его спеки); сами решения о кулдауне инкапсулированы в
 * `withinCooldown`.
 */
export class TrollCooldownRegistry {
  /** Время последней проверки по УК РФ в чате (мс) — для кулдауна. */
  public readonly lastAnalysisAt = new Map<number, number>();
  /** Время последнего случайного подкола в чате (мс) — для кулдауна. */
  public readonly lastSarcasmAt = new Map<number, number>();
  /** Время последнего кривляния в чате (мс) — для кулдауна. */
  public readonly lastMirrorAt = new Map<number, number>();
  /** Время последней реакции-эмодзи в чате (мс) — для кулдауна. */
  public readonly lastReactionAt = new Map<number, number>();
  /** Время последнего /stat в чате (мс) — для кулдауна (ключ chatId:userId). */
  public readonly lastStatAt = new Map<string, number>();
  /** Время последнего ответа на кличку/мат в чате (мс) — чтобы бот не сыпал репликами. */
  public readonly lastJerkAnswerAt = new Map<number, number>();
  /** Время последнего /meme (мс) — кулдаун на каждого участника (ключ chatId:userId). */
  public readonly lastMemeAt = new Map<string, number>();

  /**
   * @param clock порт текущего времени (по умолчанию — системные часы)
   */
  constructor(private readonly clock: Clock = new SystemClock()) {}

  /**
   * `true`, если с момента последнего события прошло меньше кулдауна.
   *
   * @typeParam K тип ключа карты (число для чатов, строка для составных ключей)
   * @param store карта «ключ → время последнего события (мс)»
   * @param key ключ события
   * @param cooldownSec длительность кулдауна в секундах; `<= 0` — кулдауна нет
   * @returns `true`, если событие ещё на кулдауне
   */
  public withinCooldown<K>(store: ReadonlyMap<K, number>, key: K, cooldownSec: number): boolean {
    if (cooldownSec <= 0) {
      return false;
    }
    const last = store.get(key);
    if (last === undefined) {
      return false;
    }
    return this.clock.timestamp() - last < cooldownSec * 1000;
  }
}
