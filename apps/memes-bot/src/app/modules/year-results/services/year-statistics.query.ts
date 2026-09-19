import { differenceInDays } from 'date-fns';
import { Repository } from 'typeorm';
import { CringePostEntity } from '../../bot/entities/cringe-post.entity';
import { PostSchedulerEntity } from '../../bot/entities/post-scheduler.entity';
import { UserRequestEntity } from '../../bot/entities/user-request.entity';
import { ObservatoryPostEntity } from '../../observatory/entities/observatory-post.entity';
import { UserYearStatistics, YearGeneralStatistics } from '../interfaces/year-statistics.interface';

/**
 * Сборщик статистики итогов года через query-builder'ы TypeORM.
 *
 * Инкапсулирует SQL-агрегации, вынесенные из god-class `YearResultsService`.
 * Класс не хранит состояние и не содержит бизнес-логики публикации: только
 * чтение из переданных репозиториев. Сервис оставляет у себя публичные обёртки
 * `collectGeneralStatistics`/`collectUserStatistics`.
 */
export class YearStatisticsQuery {
  constructor(
    private readonly userRequestRepository: Repository<UserRequestEntity>,
    private readonly cringePostRepository: Repository<CringePostEntity>,
    private readonly postSchedulerRepository: Repository<PostSchedulerEntity>,
    private readonly observatoryPostRepository: Repository<ObservatoryPostEntity>
  ) {}

  /**
   * Собирает общую статистику за год.
   *
   * @param year отчётный год
   * @returns агрегированные общие показатели
   */
  public async collectGeneralStatistics(year: number): Promise<YearGeneralStatistics> {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);

    // Всего предложено постов пользователями (включая текстовые сообщения)
    const totalProposedByUsers = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getCount();

    // Всего постов обсерватории (модерированных)
    const totalObservatoryPosts = await this.observatoryPostRepository
      .createQueryBuilder('observatory')
      .where('observatory.isApproved IS NOT NULL')
      .getCount();

    // Общее количество сообщений через модерацию
    const totalModeratedMessages = totalProposedByUsers + totalObservatoryPosts;

    // Опубликовано постов от пользователей за год (из UserRequest)
    const memesFromUsers = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.isPublished = true')
      .andWhere('userRequest.publishedAt >= :startDate', { startDate })
      .andWhere('userRequest.publishedAt <= :endDate', { endDate })
      .getCount();

    // Постов из обсерватории за год (из PostScheduler где isUserPost = false и isPublished = true)
    const memesFromObservatory = await this.postSchedulerRepository
      .createQueryBuilder('scheduler')
      .where('scheduler.isPublished = true')
      .andWhere('scheduler.isUserPost = false')
      .andWhere('scheduler.publishDate >= :startDate', { startDate })
      .andWhere('scheduler.publishDate <= :endDate', { endDate })
      .getCount();

    // Всего опубликованных постов в канале за год
    const totalMemes = memesFromUsers + memesFromObservatory;

    // Текстовые сообщения админу (без медиа)
    const textMessagesToAdmin = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.isTextRequest = true')
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getCount();

    // Сообщения с ответом админа
    const adminRepliedToMessages = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.replyToMessageId IS NOT NULL')
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getCount();

    // Процент ответов админа
    const adminReplyPercentage =
      textMessagesToAdmin > 0
        ? Math.round((adminRepliedToMessages / textMessagesToAdmin) * 100)
        : 0;

    // Кринж
    const cringeMemes = await this.cringePostRepository
      .createQueryBuilder('cringe')
      .where('cringe.isUserPost = true')
      .andWhere('cringe.createdAt >= :startDate', { startDate })
      .andWhere('cringe.createdAt <= :endDate', { endDate })
      .getCount();

    // Найдено дубликатов
    const duplicatesFound = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.isDuplicate = true')
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getCount();

    // Количество уникальных авторов
    const totalAuthorsResult = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .select('COUNT(DISTINCT userRequest.user)', 'count')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getRawOne();

    const totalAuthors = parseInt(totalAuthorsResult?.count || '0');

    // Находим количество уникальных дней с мемами и самый продуктивный день
    const daysWithMemesResult = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .select('DATE(userRequest.createdAt)', 'date')
      .addSelect('COUNT(*)', 'count')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .groupBy('DATE(userRequest.createdAt)')
      .orderBy('count', 'DESC')
      .getRawMany();

    const activeDaysWithMemes = daysWithMemesResult.length;
    const mostProductiveDayResult = daysWithMemesResult[0];

    const mostProductiveDay = mostProductiveDayResult
      ? new Date(mostProductiveDayResult.date)
      : undefined;
    const mostProductiveDayCount = mostProductiveDayResult
      ? parseInt(mostProductiveDayResult.count)
      : undefined;

    // Самый активный и мертвый месяц
    const monthlyStats = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .select('EXTRACT(MONTH FROM userRequest.createdAt)', 'month')
      .addSelect('COUNT(*)', 'count')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .groupBy('EXTRACT(MONTH FROM userRequest.createdAt)')
      .orderBy('count', 'DESC')
      .getRawMany();

    const mostActiveMonthData = monthlyStats[0];
    const leastActiveMonthData = monthlyStats[monthlyStats.length - 1];

    const monthNames = [
      'январь',
      'февраль',
      'март',
      'апрель',
      'май',
      'июнь',
      'июль',
      'август',
      'сентябрь',
      'октябрь',
      'ноябрь',
      'декабрь',
    ];

    const mostActiveMonth = mostActiveMonthData
      ? monthNames[parseInt(mostActiveMonthData.month) - 1]
      : undefined;
    const mostActiveMonthCount = mostActiveMonthData
      ? parseInt(mostActiveMonthData.count)
      : undefined;

    const leastActiveMonth =
      leastActiveMonthData && monthlyStats.length > 1
        ? monthNames[parseInt(leastActiveMonthData.month) - 1]
        : undefined;
    const leastActiveMonthCount =
      leastActiveMonthData && monthlyStats.length > 1
        ? parseInt(leastActiveMonthData.count)
        : undefined;

    // Самое популярное время публикации
    const publicationModes = await this.postSchedulerRepository
      .createQueryBuilder('scheduler')
      .select('scheduler.mode', 'mode')
      .addSelect('COUNT(*)', 'count')
      .where('scheduler.createdAt >= :startDate', { startDate })
      .andWhere('scheduler.createdAt <= :endDate', { endDate })
      .andWhere('scheduler.isUserPost = true')
      .groupBy('scheduler.mode')
      .orderBy('count', 'DESC')
      .getRawOne();

    const modeNames = {
      NEXT_MORNING: 'утро',
      NEXT_MIDDAY: 'день',
      NEXT_EVENING: 'вечер',
      NEXT_NIGHT: 'ночь',
      NIGHT_CRINGE: 'кринж',
    };

    const mostPopularPublicationMode = publicationModes?.mode
      ? modeNames[publicationModes.mode] || publicationModes.mode
      : undefined;

    // Процент дубликатов
    const totalProposed = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getCount();

    const duplicatesPercentage =
      totalProposed > 0 ? Math.round((duplicatesFound / totalProposed) * 100) : 0;

    // Пользователь с наибольшим количеством дубликатов
    const topDuplicateUserData = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .leftJoin('userRequest.user', 'user')
      .select('user.id', 'userId')
      .addSelect('user.username', 'username')
      .addSelect('user.firstName', 'firstName')
      .addSelect('user.lastName', 'lastName')
      .addSelect('COUNT(*)', 'duplicates_count')
      .addSelect(
        '(SELECT COUNT(*) FROM user_request_entity ur WHERE ur."userId" = user.id AND ur."createdAt" >= :startDate AND ur."createdAt" <= :endDate)',
        'totalCount'
      )
      .where('userRequest.isDuplicate = true')
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .groupBy('user.id')
      .addGroupBy('user.username')
      .addGroupBy('user.firstName')
      .addGroupBy('user.lastName')
      .orderBy('duplicates_count', 'DESC')
      .limit(1)
      .getRawOne();

    const topDuplicateUser = topDuplicateUserData
      ? {
          username: topDuplicateUserData.username,
          firstName: topDuplicateUserData.firstName,
          lastName: topDuplicateUserData.lastName,
          duplicatesCount: parseInt(topDuplicateUserData.duplicates_count),
          duplicatesPercentage: Math.round(
            (parseInt(topDuplicateUserData.duplicates_count) /
              parseInt(topDuplicateUserData.totalCount)) *
              100
          ),
        }
      : undefined;

    // Среднее время от создания до модерации (в минутах)
    const avgTimeToModerationResult = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .select(
        'AVG(EXTRACT(EPOCH FROM (userRequest.moderatedAt - userRequest.createdAt)) / 60)',
        'avgMinutes'
      )
      .where('userRequest.moderatedAt IS NOT NULL')
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getRawOne();

    const averageTimeToModeration = avgTimeToModerationResult?.avgMinutes
      ? Math.round(parseFloat(avgTimeToModerationResult.avgMinutes))
      : undefined;

    // Среднее время от модерации до публикации (в часах)
    const avgTimeFromModerationResult = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .select(
        'AVG(EXTRACT(EPOCH FROM (userRequest.publishedAt - userRequest.moderatedAt)) / 3600)',
        'avgHours'
      )
      .where('userRequest.isPublished = true')
      .andWhere('userRequest.moderatedAt IS NOT NULL')
      .andWhere('userRequest.publishedAt IS NOT NULL')
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getRawOne();

    const averageTimeFromModerationToPublication = avgTimeFromModerationResult?.avgHours
      ? Math.round(parseFloat(avgTimeFromModerationResult.avgHours))
      : undefined;

    // Самая длинная очередь на публикацию
    const longestQueueResult = await this.postSchedulerRepository
      .createQueryBuilder('scheduler')
      .select('DATE(scheduler.publishDate)', 'date')
      .addSelect('COUNT(*)', 'queue_length')
      .where('scheduler.createdAt >= :startDate', { startDate })
      .andWhere('scheduler.createdAt <= :endDate', { endDate })
      .andWhere('scheduler.isUserPost = true')
      .groupBy('DATE(scheduler.publishDate)')
      .orderBy('queue_length', 'DESC')
      .limit(1)
      .getRawOne();

    const longestQueueDate = longestQueueResult?.date
      ? new Date(longestQueueResult.date)
      : undefined;
    const longestQueueLength = longestQueueResult?.queue_length
      ? parseInt(longestQueueResult.queue_length)
      : undefined;

    return {
      totalModeratedMessages,
      totalMemes,
      memesFromUsers,
      memesFromObservatory,
      totalProposedByUsers,
      textMessagesToAdmin,
      adminRepliedToMessages,
      adminReplyPercentage,
      cringeMemes,
      duplicatesFound,
      year,
      totalAuthors,
      activeDaysWithMemes,
      mostProductiveDay,
      mostProductiveDayCount,
      mostActiveMonth,
      mostActiveMonthCount,
      leastActiveMonth,
      leastActiveMonthCount,
      mostPopularPublicationMode,
      duplicatesPercentage,
      averageTimeToModeration,
      averageTimeFromModerationToPublication,
      longestQueueDate,
      longestQueueLength,
      topDuplicateUser,
    };
  }

  /**
   * Собирает персональную статистику пользователей за год.
   * Только для пользователей с хотя бы 1 опубликованным постом.
   *
   * @param year отчётный год
   * @returns массив персональных показателей
   */
  public async collectUserStatistics(year: number): Promise<UserYearStatistics[]> {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);

    // Получаем пользователей, которые предложили больше 5 постов
    const usersWithStats = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .leftJoin('userRequest.user', 'user')
      .select('user.id', 'userId')
      .addSelect('user.username', 'username')
      .addSelect('user.firstName', 'firstName')
      .addSelect('user.lastName', 'lastName')
      .addSelect('COUNT(userRequest.id)', 'totalProposed')
      .addSelect(
        'SUM(CASE WHEN userRequest.isPublished = true THEN 1 ELSE 0 END)',
        'totalPublished'
      )
      .addSelect('SUM(CASE WHEN userRequest.isApproved = false THEN 1 ELSE 0 END)', 'totalRejected')
      .addSelect('MIN(userRequest.createdAt)', 'firstProposalDate')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .groupBy('user.id')
      .addGroupBy('user.username')
      .addGroupBy('user.firstName')
      .addGroupBy('user.lastName')
      .having('SUM(CASE WHEN userRequest.isPublished = true THEN 1 ELSE 0 END) > 0')
      .orderBy('COUNT(userRequest.id)', 'DESC')
      .getRawMany();

    // Для каждого пользователя получаем дополнительную статистику
    const userStatistics: UserYearStatistics[] = [];

    for (const user of usersWithStats) {
      // Получаем количество кринжа для пользователя
      const cringeCount = await this.cringePostRepository
        .createQueryBuilder('cringe')
        .leftJoin(
          'user_request_entity',
          'userRequest',
          'cringe.requestChannelMessageId = userRequest.userRequestChannelMessageId'
        )
        .leftJoin('user_entity', 'user', 'userRequest.userId = user.id')
        .where('user.id = :userId', { userId: user.userId })
        .andWhere('cringe.createdAt >= :startDate', { startDate })
        .andWhere('cringe.createdAt <= :endDate', { endDate })
        .getCount();

      // Получаем уникальные дни активности, самую длинную серию и самый продуктивный день
      const { activeDays, longestStreak, mostProductiveDay, mostProductiveDayCount } =
        await this.calculateActivityStats(parseInt(user.userId), startDate, endDate);

      // Процент одобрения
      const totalProposed = parseInt(user.totalProposed);
      const totalPublished = parseInt(user.totalPublished) || 0;
      const approvalRate =
        totalProposed > 0 ? Math.round((totalPublished / totalProposed) * 100) : 0;

      // Среднее время от предложения до публикации
      const avgTimeResult = await this.userRequestRepository
        .createQueryBuilder('userRequest')
        .select(
          'AVG(EXTRACT(EPOCH FROM (userRequest.publishedAt - userRequest.createdAt)) / 3600)',
          'avgHours'
        )
        .where('userRequest.user = :userId', { userId: parseInt(user.userId) })
        .andWhere('userRequest.isPublished = true')
        .andWhere('userRequest.createdAt >= :startDate', { startDate })
        .andWhere('userRequest.createdAt <= :endDate', { endDate })
        .getRawOne();

      const averageTimeToPublication = avgTimeResult?.avgHours
        ? Math.round(parseFloat(avgTimeResult.avgHours))
        : undefined;

      // Самое активное время суток
      const timeOfDayResult = await this.userRequestRepository
        .createQueryBuilder('userRequest')
        .select('EXTRACT(HOUR FROM userRequest.createdAt)', 'hour')
        .addSelect('COUNT(*)', 'count')
        .where('userRequest.user = :userId', { userId: parseInt(user.userId) })
        .andWhere('userRequest.createdAt >= :startDate', { startDate })
        .andWhere('userRequest.createdAt <= :endDate', { endDate })
        .groupBy('EXTRACT(HOUR FROM userRequest.createdAt)')
        .orderBy('count', 'DESC')
        .limit(1)
        .getRawOne();

      let mostActiveTimeOfDay: string | undefined;
      if (timeOfDayResult) {
        const hour = parseInt(timeOfDayResult.hour);
        if (hour >= 6 && hour < 12) {
          mostActiveTimeOfDay = 'утром';
        } else if (hour >= 12 && hour < 18) {
          mostActiveTimeOfDay = 'днём';
        } else if (hour >= 18 && hour < 24) {
          mostActiveTimeOfDay = 'вечером';
        } else {
          mostActiveTimeOfDay = 'ночью';
        }
      }

      // Количество дубликатов
      const duplicatesCount = await this.userRequestRepository
        .createQueryBuilder('userRequest')
        .where('userRequest.user = :userId', { userId: parseInt(user.userId) })
        .andWhere('userRequest.isDuplicate = true')
        .andWhere('userRequest.createdAt >= :startDate', { startDate })
        .andWhere('userRequest.createdAt <= :endDate', { endDate })
        .getCount();

      const duplicatesPercentage =
        totalProposed > 0 ? Math.round((duplicatesCount / totalProposed) * 100) : 0;

      userStatistics.push({
        userId: parseInt(user.userId),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        totalProposed,
        totalPublished,
        totalRejected: parseInt(user.totalRejected) || 0,
        totalCringe: cringeCount,
        firstProposalDate: new Date(user.firstProposalDate),
        activeDays,
        longestStreak,
        mostProductiveDay,
        mostProductiveDayCount,
        approvalRate,
        averageTimeToPublication,
        mostActiveTimeOfDay,
        duplicatesCount,
        duplicatesPercentage,
      });
    }

    return userStatistics;
  }

  /**
   * Вычисляет количество активных дней и самую длинную серию.
   *
   * @param userId идентификатор пользователя
   * @param startDate начало периода
   * @param endDate конец периода
   * @returns активные дни, серия и самый продуктивный день
   */
  private async calculateActivityStats(
    userId: number,
    startDate: Date,
    endDate: Date
  ): Promise<{
    activeDays: number;
    longestStreak: number;
    mostProductiveDay?: Date;
    mostProductiveDayCount?: number;
  }> {
    // Получаем все даты когда пользователь предлагал мемы с количеством
    const requests = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .select('DATE(userRequest.createdAt)', 'date')
      .addSelect('COUNT(*)', 'count')
      .where('userRequest.user = :userId', { userId })
      .andWhere('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .groupBy('DATE(userRequest.createdAt)')
      .orderBy('DATE(userRequest.createdAt)', 'ASC')
      .getRawMany();

    const activeDays = requests.length;

    if (activeDays === 0) {
      return { activeDays: 0, longestStreak: 0 };
    }

    // Вычисляем самую длинную серию
    let longestStreak = 1;
    let currentStreak = 1;

    for (let i = 1; i < requests.length; i++) {
      const prevDate = new Date(requests[i - 1].date);
      const currDate = new Date(requests[i].date);
      const daysDiff = differenceInDays(currDate, prevDate);

      if (daysDiff === 1) {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else {
        currentStreak = 1;
      }
    }

    // Находим самый продуктивный день (где больше 1 мема)
    let mostProductiveDay: Date | undefined;
    let mostProductiveDayCount: number | undefined;

    for (const request of requests) {
      const count = parseInt(request.count);
      if (count > 1 && (!mostProductiveDayCount || count > mostProductiveDayCount)) {
        mostProductiveDayCount = count;
        mostProductiveDay = new Date(request.date);
      }
    }

    return { activeDays, longestStreak, mostProductiveDay, mostProductiveDayCount };
  }
}
