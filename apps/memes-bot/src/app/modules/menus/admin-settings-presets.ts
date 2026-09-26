/**
 * Чистые пресеты настроек тролль-бота для админ-меню.
 *
 * Содержит списки допустимых значений, по которым кнопки настроек циклически
 * переключают параметры, а также чистую арифметику цикла и форматирование
 * подписей значений. Логика вынесена из `AdminMenuService`, который оставляет
 * у себя тонкие делегирующие обёртки. Класс не хранит состояние и не обращается
 * к сервисам — только детерминированные преобразования чисел в числа/строки.
 */
export class AdminSettingsPresets {
  /** Пресеты порога статьи УК РФ. */
  public static readonly CRIMINAL_THRESHOLD: number[] = [0.3, 0.4, 0.5, 0.6, 0.7];

  /** Пресеты порога «почти наверняка» для статьи УК РФ. */
  public static readonly CRIMINAL_HIGH_THRESHOLD: number[] = [0.7, 0.8, 0.9];

  /** Пресеты паузы анализа УК, секунды. */
  public static readonly ANALYZE_COOLDOWN_SEC: number[] = [0, 5, 10, 15, 30, 60];

  /** Пресеты шанса сарказма. */
  public static readonly SARCASM_CHANCE: number[] = [0.01, 0.03, 0.05, 0.1, 0.15, 0.2];

  /** Пресеты паузы сарказма, секунды. */
  public static readonly SARCASM_COOLDOWN_SEC: number[] = [0, 60, 300, 600, 1800, 3600];

  /** Пресеты шанса кривляния. */
  public static readonly MIRROR_CHANCE: number[] = [0.01, 0.03, 0.05, 0.1, 0.15, 0.2];

  /** Пресеты паузы кривляния, секунды. */
  public static readonly MIRROR_COOLDOWN_SEC: number[] = [0, 60, 300, 600, 1800, 3600];

  /** Пресеты шанса реакции. */
  public static readonly REACTION_CHANCE: number[] = [0.01, 0.03, 0.05, 0.1, 0.15, 0.2];

  /** Пресеты паузы реакции, секунды. */
  public static readonly REACTION_COOLDOWN_SEC: number[] = [0, 60, 300, 600, 1800, 3600];

  /** Пресеты окна ответа на обращения, секунды. */
  public static readonly JERK_WINDOW_SEC: number[] = [0, 10, 15, 30, 60, 120];

  /** Пресеты паузы между ответами, секунды. */
  public static readonly JERK_COOLDOWN_SEC: number[] = [0, 30, 60, 120, 180, 300, 600];

  /** Пресеты паузы новой беседы, минуты. */
  public static readonly DIALOG_PAUSE_MIN: number[] = [5, 10, 15, 30, 60, 120, 360];

  /** Пресеты порога самопроверки ответа. */
  public static readonly SELF_CHECK_THRESHOLD: number[] = [0.4, 0.5, 0.6, 0.7, 0.8];

  /** Пресеты шанса анонса мема. */
  public static readonly MEME_ANNOUNCE_CHANCE: number[] = [0.05, 0.1, 0.2, 0.3, 0.5];

  /** Пресеты лимита запросов в сутки. */
  public static readonly DAILY_REQUEST_LIMIT: number[] = [100, 200, 500, 1000, 2000, 4000, 5000, 10000];

  /** Пресеты максимальной длины входа. */
  public static readonly MAX_INPUT_CHARS: number[] = [500, 800, 1000, 1500, 2000, 3000];

  /**
   * Следующее значение из списка пресетов (по кругу).
   *
   * Если текущее значение точно совпадает с пресетом, берётся следующий.
   * Иначе сначала выбирается ближайший пресет, а затем следующий за ним.
   *
   * @param value текущее значение
   * @param presets непустой список допустимых значений
   * @returns следующее значение пресета (с переходом через конец списка)
   */
  public static cycle(value: number, presets: number[]): number {
    const exact = presets.findIndex((preset) => Math.abs(preset - value) < 1e-9);
    if (exact !== -1) {
      return presets[(exact + 1) % presets.length];
    }
    const nearest = presets.reduce(
      (best, preset) => (Math.abs(preset - value) < Math.abs(best - value) ? preset : best),
      presets[0]
    );
    const index = presets.indexOf(nearest);
    return presets[(index + 1) % presets.length];
  }

  /**
   * Инвертирует булев переключатель.
   *
   * @param value текущее значение
   * @returns противоположное значение
   */
  public static toggle(value: boolean): boolean {
    return !value;
  }

  /**
   * Форматирует долю как целые проценты.
   *
   * @param value доля от 0 до 1
   * @returns строка вида `50%`
   */
  public static percent(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  /**
   * Форматирует длительность в удобную подпись.
   *
   * @param sec длительность в секундах
   * @returns `без паузы`, секунды, минуты или часы
   */
  public static duration(sec: number): string {
    if (sec <= 0) return 'без паузы';
    if (sec < 60) return `${sec} с`;
    if (sec < 3600) return `${Math.round(sec / 60)} мин`;
    return `${Math.round(sec / 3600)} ч`;
  }
}
