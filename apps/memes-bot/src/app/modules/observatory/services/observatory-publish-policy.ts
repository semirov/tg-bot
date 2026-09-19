import { ScheduledPostContextInterface } from '../../bot/services/post-scheduler.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import {
  PublicationModeHandlers,
  runPublicationMode,
} from '../../../shared/publication/publication-mode';

/**
 * Политика маршрутизации публикации обсерватории по режимам.
 *
 * Тонкий seam над общим {@link runPublicationMode}: хранит карту обработчиков
 * слотов (`now`/`scheduled`/`nightCringe`) и делегирует выбор режима общему
 * shared-слою. `ObservatoryService.publishWithContext` остаётся тонким
 * делегатом, поэтому white-box спецификация продолжает подменять обработчики
 * (`onPublishNow`, `publishScheduled`, `publishNightCringeScheduled`) напрямую.
 */
export class ObservatoryPublishPolicy {
  /**
   * @param handlers обработчики слотов публикации
   */
  constructor(
    private readonly handlers: PublicationModeHandlers<ScheduledPostContextInterface>
  ) {}

  /**
   * Выполняет публикацию в соответствии с режимом.
   *
   * @param mode режим публикации
   * @param context контекст публикации
   * @returns результат выбранного обработчика или `undefined` для неизвестного режима
   */
  public run(
    mode: PublicationModesEnum,
    context: ScheduledPostContextInterface
  ): Promise<void> | void {
    return runPublicationMode(mode, this.handlers, context);
  }
}
