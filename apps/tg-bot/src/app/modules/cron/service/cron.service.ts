import {Injectable} from '@nestjs/common';
import {Cron, Interval} from '@nestjs/schedule';
import {PostSchedulerService, ScheduledPostContextInterface} from '../../bot/services/post-scheduler.service';
import {UserPostManagementService} from '../../post-management/user-post-management.service';
import {ObservatoryService} from "../../observatory/services/observatory.service";
import {CringeManagementService} from "../../bot/services/cringe-management.service";

@Injectable()
export class CronService {
  constructor(
    private postSchedulerService: PostSchedulerService,
    private userPostManagementService: UserPostManagementService,
    private observatoryService: ObservatoryService,
    private cringeManagementService: CringeManagementService
  ) {
  }

  @Interval(60000 * 5)
  async handleCron() {
    await this.handleNextScheduledPost();
    await this.tryToMoveCringe();
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

  private async tryToMoveCringe(): Promise<void> {
    if (!this.postSchedulerService.nowIsMorning) {
      return;
    }
    await this.cringeManagementService.moveCringeMessages();
  }
}
