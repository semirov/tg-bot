import {Injectable} from '@nestjs/common';
import {Cron, Interval} from '@nestjs/schedule';
import {PostSchedulerService, ScheduledPostContext} from '../../bot/services/post-scheduler.service';
import {UserPostManagementService} from '../../post-management/user-post-management.service';
import {ObservatoryService} from "../../observatory/services/observatory.service";

@Injectable()
export class CronService {
  constructor(
    private postSchedulerService: PostSchedulerService,
    private userPostManagementService: UserPostManagementService,
    private observatoryService: ObservatoryService,
  ) {
  }

  // @Interval(5000)
  @Cron('0 * * * * *')
  async handleCron() {
    await this.handleNextScheduledPost();
  }

  async handleNextScheduledPost(): Promise<void> {
    const post = await this.postSchedulerService.nextScheduledPost();
    if (!post) {
      return;
    }

    const publishContext: ScheduledPostContext = {
      mode: post.mode,
      requestChannelMessageId: post.requestChannelMessageId,
      processedByModerator: post.processedByModerator,
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
}
