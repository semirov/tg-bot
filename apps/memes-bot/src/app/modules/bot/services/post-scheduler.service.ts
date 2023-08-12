import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { PostSchedulerEntity } from '../entities/post-scheduler.entity';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { SchedulerCommonService } from '../../common/scheduler-common.service';
import { add, differenceInMinutes, isAfter, set } from 'date-fns';
import { utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';

export interface ScheduledPostContextInterface {
  mode: PublicationModesEnum;
  requestChannelMessageId: number;
  processedByModerator: number;
  caption?: string;
  isUserPost: boolean;
  hash: string;
}

@Injectable()
export class PostSchedulerService {
  constructor(
    @InjectRepository(PostSchedulerEntity)
    private postSchedulerEntity: Repository<PostSchedulerEntity>
  ) {}

  public get repository(): Repository<PostSchedulerEntity> {
    return this.postSchedulerEntity;
  }

  public nextScheduledPost(): Promise<PostSchedulerEntity | null> {
    return this.postSchedulerEntity.findOne({
      relations: { processedByModerator: true },
      where: {
        publishDate: LessThan(new Date()),
        isPublished: false,
      },
      order: { publishDate: 'DESC' },
    });
  }

  public nowIsMode(mode: PublicationModesEnum): boolean {
    const interval = SchedulerCommonService.timeIntervalByMode(mode);
    const nowTimeStamp = new Date();
    const startTimestamp = zonedTimeToUtc(set(nowTimeStamp, interval.from), 'Europe/Moscow');
    const endTimestamp = zonedTimeToUtc(set(nowTimeStamp, interval.to), 'Europe/Moscow');
    return nowTimeStamp >= startTimestamp && nowTimeStamp <= endTimestamp;
  }

  public async addPostToSchedule(context: ScheduledPostContextInterface): Promise<Date> {
    const publishDate = await this.nextScheduledTimeByMode(context.mode);

    const count = await this.repository.count({
      where: { requestChannelMessageId: context.requestChannelMessageId },
    });
    if (count) {
      return;
    }

    const scheduledPost = await this.repository.create({
      publishDate: publishDate,
      requestChannelMessageId: context.requestChannelMessageId,
      processedByModerator: { id: context.processedByModerator },
      mode: context.mode,
      caption: context.caption,
      isPublished: false,
      isUserPost: context.isUserPost,
      hash: context.hash,
    });

    await this.repository.save(scheduledPost, { transaction: true });

    return publishDate;
  }

  public static formatToMsk(date: Date): Date {
    return utcToZonedTime(date, 'Europe/Moscow');
  }

  private async nextScheduledTimeByMode(mode: PublicationModesEnum): Promise<Date> {
    const interval = SchedulerCommonService.timeIntervalByMode(mode);

    const nowTimeStamp = new Date();
    let startTimestamp = zonedTimeToUtc(set(nowTimeStamp, interval.from), 'Europe/Moscow');
    let endTimestamp = zonedTimeToUtc(set(nowTimeStamp, interval.to), 'Europe/Moscow');
    const nowIsAfterEnd = isAfter(nowTimeStamp, endTimestamp);
    const nowIsInInterval = nowTimeStamp >= startTimestamp && nowTimeStamp <= endTimestamp;

    // если прям сейчас дальше начала интервала, переносим на следующий день
    if (nowIsAfterEnd) {
      startTimestamp = add(startTimestamp, { days: 1 });
      endTimestamp = add(endTimestamp, { days: 1 });
    }

    // если сейчас внутри интервала, двигаем левый конец на текущее время
    if (nowIsInInterval) {
      startTimestamp = nowTimeStamp;
    }

    const scheduledPosts: PostSchedulerEntity[] = await this.postSchedulerEntity.find({
      where: { publishDate: Between(startTimestamp, endTimestamp), mode, isPublished: false },
      order: { publishDate: 'DESC' },
      select: ['publishDate'],
      cache: false,
    });

    // формируем границы интервала
    const postIntervals = [
      set(startTimestamp, { seconds: 0, milliseconds: 0 }).getTime(),
      ...scheduledPosts.map((post) =>
        set(post.publishDate, { seconds: 0, milliseconds: 0 }).getTime()
      ),
      set(endTimestamp, { seconds: 0, milliseconds: 0 }).getTime(),
    ];

    // получаем уникальные метки времени
    const uniqueTimes = [...new Set(postIntervals)].sort((a, b) => a - b);

    // формируем границы со значением интервалов
    const intervalsArray = uniqueTimes.reduce((acc, curr, index, arr) => {
      const prev = arr[index - 1];
      if (!prev) {
        return acc;
      }
      const diff = differenceInMinutes(curr, prev);

      acc.push({ diff, left: new Date(prev), right: new Date(curr) });

      return acc;
    }, []);

    // ищем максимальный интервал
    const maxInterval = intervalsArray.reduce(function (prev, current) {
      return prev.diff > current.diff ? prev : current;
    });

    // возвращаем дату публикации посреди максимального интервала времени
    return add(maxInterval.left, { minutes: maxInterval.diff / 2 });
  }

  async markPostAsPublished(id: number): Promise<any> {
    return this.postSchedulerEntity.update({ id }, { isPublished: true });
  }

  public async getScheduledPost(): Promise<PostSchedulerEntity[]> {
    const nowTimeStamp = new Date();
    const startTimestamp = zonedTimeToUtc(nowTimeStamp, 'Europe/Moscow');
    return this.postSchedulerEntity.find({
      where: { publishDate: MoreThanOrEqual(startTimestamp), isPublished: false },
      relations: { processedByModerator: true },
      order: { publishDate: 'ASC' },
      cache: false,
    });
  }
}
