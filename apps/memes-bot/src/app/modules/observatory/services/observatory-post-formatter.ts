import { InlineKeyboard } from 'grammy';
import { UserPostFormatter } from '../../post-management/services/user-post-formatter';
import { escapeHtml, TelegramPostSource } from '../../../shared/publication/telegram-link';
import { ObservatoryPostMenusEnum } from '../contsants/observatory-post-menus.enum';

/**
 * Чистые builder'ы сообщений и клавиатур обсерватории.
 *
 * Все методы детерминированы, не обращаются к сети/БД и не хранят состояние.
 * Логика вынесена из god-class `ObservatoryService`, который оставляет у себя
 * меню и методы-делегаты. Переиспользуемые с post-management метки и формат
 * времени берутся из {@link UserPostFormatter}, чтобы не дублировать строки.
 * Вывод обязан быть байт-в-байт идентичен прежним строкам сервиса — на них
 * опираются white-box и e2e-тесты.
 */
export class ObservatoryPostFormatter {
  private readonly userPostFormatter = new UserPostFormatter();

  /** Метка заголовка меню поста обсерватории. */
  public static readonly POST_MENU_LABEL = '🤖 Пост обсерватории';

  /** Метка кнопки перехода к публикации. */
  public static readonly PUBLISH_LABEL = 'Опубликовать';

  /** Метка кнопки отклонения поста. */
  public static readonly REJECT_LABEL = 'Отклонить';

  /** Метка режима «Кринж» (общая с post-management). */
  public static readonly PUBLISH_NIGHT_CRINGE_LABEL = UserPostFormatter.PUBLISH_NIGHT_CRINGE_LABEL;

  /** Метка режима «Сейчас» (общая с post-management). */
  public static readonly PUBLISH_NOW_LABEL = UserPostFormatter.PUBLISH_NOW_LABEL;

  /** Метка режима «Ближайший слот» (общая с post-management). */
  public static readonly PUBLISH_NEXT_INTERVAL_LABEL =
    UserPostFormatter.PUBLISH_NEXT_INTERVAL_LABEL;

  /** Метка режима «Ночью» (общая с post-management). */
  public static readonly PUBLISH_NIGHT_LABEL = UserPostFormatter.PUBLISH_NIGHT_LABEL;

  /** Метка режима «Утром» (общая с post-management). */
  public static readonly PUBLISH_MORNING_LABEL = UserPostFormatter.PUBLISH_MORNING_LABEL;

  /** Метка режима «Днем» (общая с post-management). */
  public static readonly PUBLISH_MIDDAY_LABEL = UserPostFormatter.PUBLISH_MIDDAY_LABEL;

  /** Метка режима «Вечером» (общая с post-management). */
  public static readonly PUBLISH_EVENING_LABEL = UserPostFormatter.PUBLISH_EVENING_LABEL;

  /** Метка кнопки возврата (общая с post-management). */
  public static readonly BACK_LABEL = UserPostFormatter.BACK_LABEL;

  /** Префикс служебной подписи источника. */
  public static readonly SOURCE_LABEL = '🔎 Источник:';

  /**
   * Собирает служебную подпись со ссылкой на исходный пост.
   *
   * Подпись показывается только в предложке и в публикуемый пост не попадает.
   * Если ссылка на источник неизвестна — возвращает пустую строку.
   *
   * @param source источник поста (канал, пост, ссылка)
   * @returns HTML-строка подписи или `''`
   */
  public sourceCaption(source: TelegramPostSource | null | undefined): string {
    if (!source?.url) {
      return '';
    }

    const title = escapeHtml(source.title || source.username || 'исходный канал');
    return `${ObservatoryPostFormatter.SOURCE_LABEL} <a href="${source.url}">${title}</a>`;
  }

  /**
   * Собирает подпись публикуемого поста из исходной подписи и ссылки на канал.
   *
   * Пустые части отбрасываются, оставшиеся соединяются переводом строки —
   * как в исходном `[caption, link].filter(Boolean).join('\n')`.
   *
   * @param caption исходная подпись поста
   * @param channelLink HTML-ссылка на канал
   * @returns итоговая подпись
   */
  public composeCaption(
    caption: string | null | undefined,
    channelLink: string | null | undefined
  ): string {
    return [caption, channelLink].filter((item) => !!item).join('\n');
  }

  /**
   * Метка опубликованного поста в канале.
   *
   * @param username имя модератора
   * @returns метка вида `🤖 Опубликован (moder)`
   */
  public publishedLabel(username: string): string {
    return `🤖 Опубликован (${username})`;
  }

  /**
   * Клавиатура со ссылкой на только что опубликованный пост.
   *
   * @param username имя модератора
   * @param url ссылка на канал
   * @returns клавиатура из одной URL-кнопки
   */
  public publishedKeyboard(username: string, url: string): InlineKeyboard {
    return new InlineKeyboard().url(this.publishedLabel(username), url).row();
  }

  /**
   * Клавиатура запланированного поста с датой и ником модератора.
   *
   * Формат времени переиспользуется из post-management.
   *
   * @param dateFormatted отформатированная дата публикации
   * @param username имя модератора
   * @returns клавиатура из одной кнопки
   */
  public scheduledKeyboard(dateFormatted: string, username: string): InlineKeyboard {
    return new InlineKeyboard()
      .text(this.userPostFormatter.scheduledTimeLabel(dateFormatted, username))
      .row();
  }

  /**
   * Клавиатура отклонённого поста обсерватории.
   *
   * @param username имя модератора
   * @returns клавиатура с кнопкой удаления отклонённого поста
   */
  public rejectedKeyboard(username: string): InlineKeyboard {
    return new InlineKeyboard()
      .text(
        `🤖 Отклонен ❌ (${username})`,
        ObservatoryPostMenusEnum.DELETE_OBSERVER_POST
      )
      .row();
  }

}
