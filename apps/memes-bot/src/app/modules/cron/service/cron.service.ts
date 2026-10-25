import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { GrammyError } from 'grammy';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../../bot/services/post-scheduler.service';
import { UserPostManagementService } from '../../post-management/user-post-management.service';
import { ObservatoryService } from '../../observatory/services/observatory.service';
import { CringeManagementService } from '../../bot/services/cringe-management.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { MonthlyStatService } from './monthly-stat.service';
import { YearResultsService } from '../../year-results/services/year-results.service';
import { QueueAlertService } from './queue-alert.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private postSchedulerService: PostSchedulerService,
    private userPostManagementService: UserPostManagementService,
    private observatoryService: ObservatoryService,
    private cringeManagementService: CringeManagementService,
    private monthlyStatService: MonthlyStatService,
    private yearResultsService: YearResultsService,
    private queueAlertService: QueueAlertService
  ) {}

  @Interval(60000)
  async handleCron() {
    await this.handleNextScheduledPost();
    await this.tryToMoveCringe();
  }

  /** Раз в 10 минут проверяем, не пустеет ли очередь публикации. */
  @Interval(600000)
  async checkQueueAlerts(): Promise<void> {
    try {
      await this.queueAlertService.check();
    } catch (error) {
      this.logger.error('Failed to check queue alerts', error as never);
    }
  }

  @Cron('0 17 9 * *')
  async onCronTime(): Promise<void> {
    this.monthlyStatService.publishMonthlyStatistic();
  }

  /**
   * Генерация итогов года 25 декабря в 10:00
   * Формат: секунды минуты часы день месяц день_недели
   * Месяцы: 0-11 (0=январь, 11=декабрь)
   */
  @Cron('0 0 10 25 11 *')
  async generateYearResults(): Promise<void> {
    try {
      const currentYear = new Date().getFullYear();
      this.logger.log(`Starting automatic year results generation for ${currentYear}`);
      await this.yearResultsService.generateAndSendPreviewToOwner(currentYear);
      this.logger.log(`Year results generation completed for ${currentYear}`);
    } catch (error) {
      this.logger.error('Failed to generate year results:', error);
    }
  }

  async handleNextScheduledPost(): Promise<void> {
    const post = await this.postSchedulerService.nextScheduledPost();
    if (!post) {
      return;
    }

    // Атомарный claim вместо «read → publish → mark»: только один обработчик
    // переводит пост в `isPublished`, остальные видят `false` и не публикуют.
    // Fail closed: claim не снимается, если публикация упала — дубликат в
    // канале хуже пропущенного поста (TGB-117).
    const claimed = await this.postSchedulerService.claimPostForPublish(post.id);
    if (!claimed) {
      this.logger.log(
        `publish source=cron sched=${post.id} card=${post.requestChannelMessageId} claim=already-claimed outcome=skipped`
      );
      return;
    }

    try {
      // Контекст собираем внутри try: битая запись (нет модератора) не должна
      // сжечь claim без следа в логе.
      const publishContext: ScheduledPostContextInterface = {
        mode: post.mode,
        requestChannelMessageId: post.requestChannelMessageId,
        processedByModerator: post.processedByModerator.id,
        caption: post.caption,
        isUserPost: post.isUserPost,
        hash: post.hash,
        source: 'cron',
      };

      if (post.isUserPost) {
        await this.userPostManagementService.onPublishNow(publishContext);
      } else {
        await this.observatoryService.onPublishNow(publishContext);
      }
    } catch (e) {
      // Claim намеренно не снимаем: повторная публикация того же поста хуже
      // пропуска. warn — оператору нужно найти и снять claim вручную
      // (TGB-117: UPDATE post_scheduler SET isPublished=false WHERE
      // requestChannelMessageId=<card>). В лог — только класс/описание ошибки.
      this.logger.warn(
        `publish source=cron sched=${post.id} card=${post.requestChannelMessageId} claim=claimed ` +
          `outcome=error:${CronService.errorLabel(e)}`
      );
    }
  }

  /**
   * Короткая метка ошибки публикации для лога.
   *
   * Для `GrammyError` берём только `description` от Telegram (без подписей и
   * тел постов), для остальных — имя класса: сообщения БД могут содержать
   * параметры запроса.
   *
   * @param error пойманная ошибка публикации
   * @returns метка класса/описания ошибки
   */
  private static errorLabel(error: unknown): string {
    if (error instanceof GrammyError) {
      return `${error.name}:${error.description}`;
    }
    return error instanceof Error ? error.name : 'UnknownError';
  }

  /**
   * Перемещаем посты кринжа когда выходим из интервала, пытаться переместить начнем за переход в интервал to
   */
  private async tryToMoveCringe(): Promise<void> {
    if (this.postSchedulerService.nowIsMode(PublicationModesEnum.NIGHT_CRINGE)) {
      return;
    }
    await this.cringeManagementService.moveCringeMessages();
  }
}
