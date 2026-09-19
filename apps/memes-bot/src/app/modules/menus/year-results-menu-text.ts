import { pluralizeRu } from '../../shared/russian-plural';
import { DisplayNameSource, formatUserName as formatDisplayName } from '../../shared/display-name';

/**
 * Чистые текстовые builders подписей админ-меню.
 *
 * Собирает детерминированные строки меню и предпросмотра итогов года: не
 * обращается к сервисам, БД или сети. Вынесено из `AdminMenuService`, который
 * оставляет у себя тонкие делегирующие обёртки. Форматирование имени и
 * склонения не дублируются — используются `shared/display-name` и
 * `shared/russian-plural`.
 */
export class YearResultsMenuText {
  /** Формы слова «час» для сообщений о снятии лимита мемов. */
  private static readonly HOUR_FORMS = ['час', 'часа', 'часов'] as const;

  /**
   * Форматирует отображаемое имя пользователя.
   *
   * @param user объект с полями `username`/`firstName`/`lastName`
   * @returns `@username` либо «Имя Фамилия»
   */
  public formatUserName(user: DisplayNameSource): string {
    return formatDisplayName(user);
  }

  /**
   * Подпись кнопки снятия лимита мемов.
   *
   * @param hours срок снятия лимита в часах
   * @returns строка вида `Снять лимит на 24 часа`
   */
  public limitButtonLabel(hours: number): string {
    return `Снять лимит на ${hours} ${pluralizeRu(hours, YearResultsMenuText.HOUR_FORMS)}`;
  }

  /**
   * Сообщение об успешном снятии лимита мемов.
   *
   * @param hours срок снятия лимита в часах
   * @returns строка подтверждения для пользователя
   */
  public limitRemovedMessage(hours: number): string {
    return `Лимит мемов снят для пользователя на ${hours} ${pluralizeRu(
      hours,
      YearResultsMenuText.HOUR_FORMS
    )}`;
  }

  /**
   * Сообщение о начале генерации итогов года.
   *
   * @returns текст статуса
   */
  public generating(): string {
    return 'Генерирую итоги года...';
  }

  /**
   * Заголовок предпросмотра общей статистики.
   *
   * @returns HTML-заголовок, после которого идёт текст статистики
   */
  public generalPreviewHeader(): string {
    return '<b>📊 Предпросмотр общей статистики для канала:</b>\n\n';
  }

  /**
   * Заголовок блока персональных сообщений.
   *
   * @param count количество персональных сообщений
   * @returns HTML-заголовок с подсказкой о навигации
   */
  public personalListHeader(count: number): string {
    return `<b>📨 Персональные сообщения (${count}):</b>\n\nИспользуйте кнопки для навигации`;
  }

  /**
   * Предпросмотр персонального сообщения пользователя.
   *
   * @param user пользователь, к которому относится сообщение
   * @param message готовый текст персонального сообщения
   * @returns HTML-текст предпросмотра
   */
  public userPreviewText(user: DisplayNameSource, message: string): string {
    return `<b>📨 Предпросмотр сообщения для ${this.formatUserName(user)}:</b>\n\n${message}`;
  }

  /**
   * Подсказка о команде публикации итогов.
   *
   * @returns текст подсказки
   */
  public publishHint(): string {
    return 'Для публикации итогов используйте команду /year_result_publish';
  }

  /**
   * Сообщение об ошибке генерации итогов.
   *
   * @returns текст ошибки
   */
  public generationError(): string {
    return 'Произошла ошибка при генерации итогов года';
  }

  /**
   * Подписи навигации по персональным сообщениям.
   *
   * @param index индекс текущего пользователя
   * @param total общее число пользователей
   * @returns подписи кнопок; крайние скрываются (`undefined`)
   */
  public navigation(index: number, total: number): {
    previous?: string;
    counter: string;
    next?: string;
  } {
    return {
      previous: index > 0 ? '⬅️ Предыдущий' : undefined,
      counter: `${index + 1}/${total}`,
      next: index < total - 1 ? 'Следующий ➡️' : undefined,
    };
  }

  /**
   * Сообщение о начале публикации итогов.
   *
   * @returns текст статуса
   */
  public publishing(): string {
    return 'Публикую итоги года...';
  }

  /**
   * Сообщение об успешной публикации общей статистики.
   *
   * @returns текст статуса
   */
  public generalPublished(): string {
    return '✅ Общая статистика опубликована в канал';
  }

  /**
   * Сообщение об успешной отправке персональной статистики.
   *
   * @returns текст статуса
   */
  public personalPublished(): string {
    return '✅ Персональная статистика отправлена пользователям';
  }

  /**
   * Финальное сообщение об успешной публикации итогов.
   *
   * @returns текст статуса
   */
  public published(): string {
    return '🎉 Итоги года успешно опубликованы!';
  }

  /**
   * Сообщение об ошибке публикации итогов.
   *
   * @returns текст ошибки
   */
  public publishError(): string {
    return 'Произошла ошибка при публикации итогов года';
  }
}
