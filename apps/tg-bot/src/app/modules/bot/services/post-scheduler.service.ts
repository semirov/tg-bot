import {Injectable} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Between, LessThan, MoreThan, Repository} from 'typeorm';
import {PostSchedulerEntity} from '../entities/post-scheduler.entity';
import {PublicationModesEnum} from '../../post-management/constants/publication-modes.enum';
import {SchedulerCommonService} from '../../common/scheduler-common.service';
import {add, isAfter, set} from 'date-fns';

export interface ScheduledPostContext {
  mode: PublicationModesEnum;
  requestChannelMessageId: number;
  processedByModerator;
  caption?: string;
  isUserPost: boolean;
}

@Injectable()
export class PostSchedulerService {
  constructor(
    @InjectRepository(PostSchedulerEntity)
    private postSchedulerEntity: Repository<PostSchedulerEntity>
  ) {
  }

  public get repository(): Repository<PostSchedulerEntity> {
    return this.postSchedulerEntity;
  }

  public nextScheduledPost(): Promise<PostSchedulerEntity | null> {
    return this.postSchedulerEntity.findOne({
      where: {publishDate: LessThan(new Date()), isPublished: false},
      order: {publishDate: 'DESC'},
    });
  }

  public async addPostToSchedule(context: ScheduledPostContext): Promise<Date> {
    const publishDate = await this.nextScheduledTimeByMode(context.mode);

    const scheduledPost = await this.repository.create({
      publishDate: publishDate,
      requestChannelMessageId: context.requestChannelMessageId,
      processedByModerator: context.processedByModerator,
      mode: context.mode,
      caption: context.caption,
      isPublished: false,
      isUserPost: context.isUserPost,
    });

    await this.repository.save(scheduledPost);

    return publishDate;
  }

  private async nextScheduledTimeByMode(mode: PublicationModesEnum): Promise<Date> {
    const interval = SchedulerCommonService.timeIntervalByMode(mode);

    const nowTimeStamp = new Date();
    let startTimestamp = set(new Date(), interval.from);
    let endTimestamp = set(new Date(), interval.to);
    const nowIsAfterEnd = isAfter(nowTimeStamp, endTimestamp);
    const nowIsInInterval = nowTimeStamp >= startTimestamp && nowTimeStamp <= endTimestamp;

    if (nowIsAfterEnd) {
      startTimestamp = add(startTimestamp, {days: 1});
      endTimestamp = add(endTimestamp, {days: 1});
    }

    let lastPublishPost: PostSchedulerEntity = null;

    switch (true) {
      case nowIsInInterval && mode !== PublicationModesEnum.IN_QUEUE:
        lastPublishPost = await this.postSchedulerEntity.findOne({
          where: {publishDate: Between(nowTimeStamp, endTimestamp), mode, isPublished: false},
          order: {publishDate: 'DESC'},
        });
        break;

      case mode === PublicationModesEnum.IN_QUEUE:
        lastPublishPost = await this.postSchedulerEntity.findOne({
          where: {
            publishDate: Between(nowTimeStamp, endTimestamp),
            mode,
            isPublished: false,
          },
          order: {publishDate: 'DESC'},
        });
        if (!lastPublishPost) {
          return add(new Date(), {minutes: 5});
        }
        break;

      default:
        lastPublishPost = await this.postSchedulerEntity.findOne({
          where: {publishDate: Between(startTimestamp, endTimestamp), mode, isPublished: false},
          order: {publishDate: 'DESC'},
        });
        break;
    }

    if (lastPublishPost) {
      return add(lastPublishPost.publishDate, {minutes: 5});
    }
    if (nowTimeStamp > startTimestamp) {
      return add(nowTimeStamp, {minutes: 5});
    }

    return startTimestamp;
  }

  async markPostAsPublished(id: number): Promise<any> {
    return this.postSchedulerEntity.update({id}, {isPublished: true});
  }
}
