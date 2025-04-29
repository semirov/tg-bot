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

  /**
   * Получить все запланированные посты
   */
  public async getAllScheduledPosts(): Promise<any[]> {
    return this.repository.find({
      where: {
        isPublished: false
      },
      order: {
        publishDate: 'ASC'
      }
    });
  }

  /**
   * Получить запланированный пост по ID
   */
  public async getScheduledPostById(id: number): Promise<any> {
    return this.repository.findOne({
      where: { id }
    });
  }

  private async nextScheduledTimeByMode(mode: PublicationModesEnum): Promise<Date> {
    const interval = SchedulerCommonService.timeIntervalByMode(mode);
    const MIN_INTERVAL_MINUTES = 60; // Минимальный интервал в 1 час

    const nowTimeStamp = new Date();
    let startTimestamp = zonedTimeToUtc(set(nowTimeStamp, interval.from), 'Europe/Moscow');
    let endTimestamp = zonedTimeToUtc(set(nowTimeStamp, interval.to), 'Europe/Moscow');
    const nowIsAfterEnd = isAfter(nowTimeStamp, endTimestamp);
    const nowIsInInterval = nowTimeStamp >= startTimestamp && nowTimeStamp <= endTimestamp;

    // Если текущее время после интервала, переносим на следующий день
    if (nowIsAfterEnd) {
      startTimestamp = add(startTimestamp, { days: 1 });
      endTimestamp = add(endTimestamp, { days: 1 });
    }

    // Если сейчас внутри интервала, двигаем левый конец на текущее время
    if (nowIsInInterval) {
      startTimestamp = nowTimeStamp;
    }

    // Будем искать слот в течение следующих 14 дней
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      // Если это не первая итерация, сдвигаем интервал на следующий день
      if (dayOffset > 0) {
        // Восстанавливаем границы интервала для нового дня
        startTimestamp = add(zonedTimeToUtc(set(nowTimeStamp, interval.from), 'Europe/Moscow'), { days: dayOffset });
        endTimestamp = add(zonedTimeToUtc(set(nowTimeStamp, interval.to), 'Europe/Moscow'), { days: dayOffset });
      }

      // Генерируем все возможные получасовые слоты в интервале
      const halfHourSlots: Date[] = [];
      let currentSlot = set(startTimestamp, { minutes: Math.ceil(startTimestamp.getMinutes() / 30) * 30, seconds: 0, milliseconds: 0 });

      // Если минуты кратны 30, оставляем как есть, иначе переходим к следующему получасу
      if (currentSlot.getMinutes() === 0 && startTimestamp.getMinutes() > 0) {
        currentSlot = add(currentSlot, { minutes: 30 });
      }

      while (currentSlot <= endTimestamp) {
        halfHourSlots.push(new Date(currentSlot));
        currentSlot = add(currentSlot, { minutes: 30 });
      }

      // Получаем все запланированные посты в интервале
      const scheduledPosts: PostSchedulerEntity[] = await this.postSchedulerEntity.find({
        where: {
          publishDate: Between(add(startTimestamp, { minutes: -MIN_INTERVAL_MINUTES }), add(endTimestamp, { minutes: MIN_INTERVAL_MINUTES })),
          isPublished: false
        },
        order: { publishDate: 'ASC' },
        select: ['publishDate'],
        cache: false,
      });

      // Фильтруем слоты, оставляя только те, которые удовлетворяют условию минимального интервала
      const validSlots = halfHourSlots.filter(slot => {
        return scheduledPosts.every(post =>
          Math.abs(differenceInMinutes(post.publishDate, slot)) >= MIN_INTERVAL_MINUTES
        );
      });

      if (validSlots.length > 0) {
        if (mode === PublicationModesEnum.NOW_SILENT || mode === PublicationModesEnum.NIGHT_CRINGE || mode === PublicationModesEnum.NEXT_INTERVAL) {
          // Для этих режимов берем первый доступный слот
          validSlots.sort((a, b) => a.getTime() - b.getTime());
          return validSlots[0];
        } else {
          // Для остальных режимов стремимся к равномерному распределению
          const allTimePoints = [
            ...scheduledPosts.map(post => post.publishDate),
          ].sort((a, b) => a.getTime() - b.getTime());

          if (allTimePoints.length === 0) {
            // Если нет запланированных постов, выбираем слот в середине интервала
            const middleIndex = Math.floor(validSlots.length / 2);
            return validSlots[middleIndex];
          }

          // Вычисляем "расстояние" каждого слота от других постов
          const slotDistances = validSlots.map(slot => {
            // Находим ближайший пост
            const distances = allTimePoints.map(point => Math.abs(differenceInMinutes(point, slot)));
            const minDistance = Math.min(...distances);
            return { slot, minDistance };
          });

          // Сортируем слоты по убыванию минимального расстояния
          slotDistances.sort((a, b) => b.minDistance - a.minDistance);

          // Возвращаем слот с наибольшим минимальным расстоянием (наиболее удаленный от других постов)
          return slotDistances[0].slot;
        }
      }
    }

    // Если не нашли подходящий слот в течение 14 дней, возвращаем дату через 14 дней,
    // также кратную 30 минутам
    const fallbackDate = add(nowTimeStamp, { days: 14, hours: 12 });
    const fallbackMinutes = fallbackDate.getMinutes();
    const fallbackRemainder = fallbackMinutes % 30;
    return set(
      add(fallbackDate, { minutes: fallbackRemainder ? 30 - fallbackRemainder : 0 }),
      { seconds: 0, milliseconds: 0 }
    );
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
