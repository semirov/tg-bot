import { PublicationModesEnum } from '../../modules/post-management/constants/publication-modes.enum';

/**
 * Диспетчеризация режимов публикации — общий слой пайплайна UPM/OBS.
 *
 * Осознанный seam: сами шаги публикации (`onPublishNow`, `publishScheduled`,
 * `publishNightCringeScheduled`) остаются в `UserPostManagementService` и
 * `ObservatoryService`, потому что пишут в разные репозитории и формируют разные
 * сообщения/побочные эффекты. Общими вынесены только бэкенд-агностичные части:
 * выбор обработчика по режиму (этот файл), построение ссылки на файл Telegram
 * (`./media-url`) и отправка в Mattermost (`./mattermost-post`). Полный
 * `PostPublisherService` не вводится, пока не появится единый порт
 * репозитория/ответчика, разделяемый обоими сервисами.
 */

/**
 * Целевой слот публикации, которому соответствует режим.
 *
 * - `now` — публикация немедленно;
 * - `scheduled` — постановка в расписание;
 * - `nightCringe` — ночная рубрика кринжа с отдельной записью.
 */
export type PublicationModeSlot = 'now' | 'scheduled' | 'nightCringe';

/**
 * Обработчик публикации для конкретного слота.
 *
 * @typeParam Context контекст публикации (например `ScheduledPostContextInterface`)
 */
export type PublicationModeHandler<Context> = (context: Context) => Promise<void> | void;

/**
 * Набор обработчиков публикации по слотам.
 *
 * @typeParam Context контекст публикации
 */
export interface PublicationModeHandlers<Context> {
  /** Публикация немедленно. */
  now: PublicationModeHandler<Context>;
  /** Постановка в расписание. */
  scheduled: PublicationModeHandler<Context>;
  /** Ночной кринж: отдельная запись + расписание. */
  nightCringe: PublicationModeHandler<Context>;
}

/**
 * Сопоставляет режим публикации целевому слоту.
 *
 * Заменяет дублировавшийся `switch` в `UserPostManagementService.onPublishActions`
 * и `ObservatoryService.publishWithContext`. Неизвестный режим не планируется и
 * возвращает `undefined` — поведение исходных `switch` без ветки `default`.
 *
 * @param mode режим публикации
 * @returns слот публикации или `undefined` для неизвестного режима
 */
export function resolvePublicationModeSlot(
  mode: PublicationModesEnum
): PublicationModeSlot | undefined {
  switch (mode) {
    case PublicationModesEnum.NOW_SILENT:
      return 'now';
    case PublicationModesEnum.NEXT_MORNING:
    case PublicationModesEnum.NEXT_MIDDAY:
    case PublicationModesEnum.NEXT_EVENING:
    case PublicationModesEnum.NEXT_INTERVAL:
    case PublicationModesEnum.NEXT_NIGHT:
      return 'scheduled';
    case PublicationModesEnum.NIGHT_CRINGE:
      return 'nightCringe';
    default:
      return undefined;
  }
}

/**
 * Выполняет публикацию в соответствии с режимом.
 *
 * Синхронно выбирает обработчик по слоту и возвращает результат его вызова
 * (включая промис), поэтому порядок и момент side effect'ов не меняются по
 * сравнению с исходными `switch`.
 *
 * @typeParam Context контекст публикации
 * @param mode режим публикации
 * @param handlers обработчики слотов
 * @param context контекст, передаваемый выбранному обработчику
 * @returns результат выбранного обработчика или `undefined` для неизвестного режима
 */
export function runPublicationMode<Context>(
  mode: PublicationModesEnum,
  handlers: PublicationModeHandlers<Context>,
  context: Context
): Promise<void> | void {
  switch (resolvePublicationModeSlot(mode)) {
    case 'now':
      return handlers.now(context);
    case 'scheduled':
      return handlers.scheduled(context);
    case 'nightCringe':
      return handlers.nightCringe(context);
    default:
      return undefined;
  }
}
