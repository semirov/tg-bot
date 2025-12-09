import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
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

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private postSchedulerService: PostSchedulerService,
    private userPostManagementService: UserPostManagementService,
    private observatoryService: ObservatoryService,
    private cringeManagementService: CringeManagementService,
    private monthlyStatService: MonthlyStatService,
    private yearResultsService: YearResultsService
  ) {}

  @Interval(60000)
  async handleCron() {
    await this.handleNextScheduledPost();
    await this.tryToMoveCringe();
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

    const publishContext: ScheduledPostContextInterface = {
      mode: post.mode,
      requestChannelMessageId: post.requestChannelMessageId,
      processedByModerator: post.processedByModerator.id,
      caption: post.caption,
      isUserPost: post.isUserPost,
      hash: post.hash,
    };

    try {
      if (post.isUserPost) {
        await this.userPostManagementService.onPublishNow(publishContext);
      } else {
        await this.observatoryService.onPublishNow(publishContext);
      }
    } catch (e) {
      console.error('error while publish scheduled post', e);
    }

    await this.postSchedulerService.markPostAsPublished(post.id);
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
