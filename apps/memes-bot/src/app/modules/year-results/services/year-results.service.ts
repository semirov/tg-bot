import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { differenceInDays, format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Bot, InlineKeyboard } from 'grammy';
import { Repository } from 'typeorm';
import { CringePostEntity } from '../../bot/entities/cringe-post.entity';
import { PostSchedulerEntity } from '../../bot/entities/post-scheduler.entity';
import { PublishedPostHashesEntity } from '../../bot/entities/published-post-hashes.entity';
import { UserRequestEntity } from '../../bot/entities/user-request.entity';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BOT } from '../../bot/providers/bot.provider';
import { BaseConfigService } from '../../config/base-config.service';
import { ObservatoryPostEntity } from '../../observatory/entities/observatory-post.entity';
import { YearResultEntity } from '../entities/year-result.entity';
import {
  UserYearStatistics,
  YearGeneralStatistics,
  YearResultsPreview,
} from '../interfaces/year-statistics.interface';

@Injectable()
export class YearResultsService {
  private readonly logger = new Logger(YearResultsService.name);

  constructor(
    @InjectRepository(YearResultEntity)
    private yearResultRepository: Repository<YearResultEntity>,
    @InjectRepository(UserRequestEntity)
    private userRequestRepository: Repository<UserRequestEntity>,
    @InjectRepository(CringePostEntity)
    private cringePostRepository: Repository<CringePostEntity>,
    @InjectRepository(PublishedPostHashesEntity)
    private publishedPostHashesRepository: Repository<PublishedPostHashesEntity>,
    @InjectRepository(PostSchedulerEntity)
    private postSchedulerRepository: Repository<PostSchedulerEntity>,
    @InjectRepository(ObservatoryPostEntity)
    private observatoryPostRepository: Repository<ObservatoryPostEntity>,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService
  ) {}

  /**
   * Собирает общую статистику за год
   */
  public async collectGeneralStatistics(year: number): Promise<YearGeneralStatistics> {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);

    // Всего постов (опубликованных)
    const totalMemes = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.isPublished = true')
      .andWhere('userRequest.publishedAt >= :startDate', { startDate })
      .andWhere('userRequest.publishedAt <= :endDate', { endDate })
      .getCount();

    // Всего предложено постов пользователями
    const totalProposedByUsers = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.createdAt >= :startDate', { startDate })
      .andWhere('userRequest.createdAt <= :endDate', { endDate })
      .getCount();

    // Опубликовано постов от людей (предложка)
    const memesFromUsers = await this.userRequestRepository
      .createQueryBuilder('userRequest')
      .where('userRequest.isPublished = true')
      .andWhere('userRequest.publishedAt >= :startDate', { startDate })
      .andWhere('userRequest.publishedAt <= :endDate', { endDate })
      .getCount();

    // Постов из обсерватории
    const memesFromObservatory = await this.observatoryPostRepository
      .createQueryBuilder('observatory')
      .where('observatory.publishedMessageId IS NOT NULL')
      .andWhere('observatory.isApproved = true')
      .getCount();

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

    return {
      totalMemes,
      memesFromUsers,
      memesFromObservatory,
      totalProposedByUsers,
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
      topDuplicateUser,
    };
  }

  /**
   * Собирает персональную статистику пользователей за год
   * Только для пользователей с хотя бы 1 опубликованным постом
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
   * Вычисляет количество активных дней и самую длинную серию
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

  /**
   * Генерирует и сохраняет результаты года
   */
  public async generateYearResults(year: number): Promise<YearResultsPreview> {
    this.logger.log(`Generating year results for ${year}`);

    const general = await this.collectGeneralStatistics(year);
    const users = await this.collectUserStatistics(year);

    // Удаляем старые результаты для этого года перед сохранением новых
    await this.yearResultRepository.delete({ year });

    // Сохраняем результаты в базу данных
    for (const user of users) {
      await this.yearResultRepository.save({
        year,
        userId: user.userId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        totalProposed: user.totalProposed,
        totalPublished: user.totalPublished,
        totalRejected: user.totalRejected,
        totalCringe: user.totalCringe,
        firstProposalDate: user.firstProposalDate,
        activeDays: user.activeDays,
        longestStreak: user.longestStreak,
        mostProductiveDay: user.mostProductiveDay,
        mostProductiveDayCount: user.mostProductiveDayCount,
        approvalRate: user.approvalRate,
        averageTimeToPublication: user.averageTimeToPublication,
        mostActiveTimeOfDay: user.mostActiveTimeOfDay,
        duplicatesCount: user.duplicatesCount,
        duplicatesPercentage: user.duplicatesPercentage,
        isPublished: false,
      });
    }

    this.logger.log(`Year results generated for ${users.length} users`);

    return { general, users };
  }

  /**
   * Получает сохраненные результаты года
   */
  public async getYearResults(year: number): Promise<YearResultsPreview> {
    const general = await this.collectGeneralStatistics(year);
    const savedResults = await this.yearResultRepository.find({
      where: { year },
      order: { totalProposed: 'DESC' },
    });

    const users: UserYearStatistics[] = savedResults.map((result) => ({
      userId: result.userId,
      username: result.username,
      firstName: result.firstName,
      lastName: result.lastName,
      totalProposed: result.totalProposed,
      totalPublished: result.totalPublished,
      totalRejected: result.totalRejected,
      totalCringe: result.totalCringe,
      firstProposalDate: result.firstProposalDate,
      activeDays: result.activeDays,
      longestStreak: result.longestStreak,
      mostProductiveDay: result.mostProductiveDay,
      mostProductiveDayCount: result.mostProductiveDayCount,
      approvalRate: result.approvalRate,
      averageTimeToPublication: result.averageTimeToPublication,
      mostActiveTimeOfDay: result.mostActiveTimeOfDay,
      duplicatesCount: result.duplicatesCount,
      duplicatesPercentage: result.duplicatesPercentage,
    }));

    return { general, users };
  }

  /**
   * Форматирует общую статистику для публикации
   */
  public formatGeneralStatistics(general: any, users: any[]): string {
    const year = general.year;
    let text = `🎉 <b>Итоги ${year} года</b>\n\n`;

    // Основная статистика: всего постов в канале
    text += `За этот год в канале было опубликовано <b>${
      general.totalMemes
    }</b> ${this.getPostsWord(general.totalMemes)}. `;

    // Статистика по обсерватории
    if (general.memesFromObservatory > 0) {
      const observatoryPercent = Math.round(
        (general.memesFromObservatory / general.totalMemes) * 100
      );
      text += `Из них <b>${general.memesFromObservatory}</b> ${this.getPostsWord(
        general.memesFromObservatory
      )} (<b>${observatoryPercent}%</b>) ${
        general.memesFromObservatory === 1 ? 'был найден' : 'были найдены'
      } обсерваторией. `;
    }

    // Статистика по пользовательским постам
    if (general.totalProposedByUsers > 0) {
      text += `Пользователи предложили <b>${general.totalProposedByUsers}</b> ${this.getPostsWord(
        general.totalProposedByUsers
      )}`;

      if (general.memesFromUsers > 0) {
        const userPublishedPercent = Math.round(
          (general.memesFromUsers / general.totalProposedByUsers) * 100
        );
        const userFromTotalPercent = Math.round(
          (general.memesFromUsers / general.totalMemes) * 100
        );

        text += `, из которых было опубликовано <b>${general.memesFromUsers}</b> (<b>${userPublishedPercent}%</b>), что составило <b>${userFromTotalPercent}%</b> от общего числа постов в канале`;
      }

      text += `. `;
    }

    // Количество авторов
    if (general.totalAuthors > 0) {
      text += `<b>${general.totalAuthors}</b> ${this.getAuthorsWord(general.totalAuthors)} ${
        general.totalAuthors === 1 ? 'создавал' : 'создавали'
      } контент для канала. `;
    }

    // Активные дни
    if (general.activeDaysWithMemes > 0) {
      text += `Посты предлагались в течение <b>${
        general.activeDaysWithMemes
      }</b> ${this.getDaysWord(general.activeDaysWithMemes)}`;
    }

    // Кринж и дубликаты
    const hasCringeOrDuplicates = general.cringeMemes > 0 || general.duplicatesFound > 0;

    if (hasCringeOrDuplicates) {
      text += `. `;

      if (general.cringeMemes > 0) {
        text += `<b>${general.cringeMemes}</b> ${this.getPostsWord(general.cringeMemes)} ${
          general.cringeMemes === 1 ? 'попал' : 'попали'
        } в кринж`;

        if (general.duplicatesFound > 0) {
          text += `, а система нашла <b>${general.duplicatesFound}</b> ${
            general.duplicatesFound === 1 ? 'дубликат' : 'дубликатов'
          }`;
        }
      } else if (general.duplicatesFound > 0) {
        text += `Система нашла <b>${general.duplicatesFound}</b> ${
          general.duplicatesFound === 1 ? 'дубликат' : 'дубликатов'
        }`;
      }

      text += `.`;
    } else {
      text += `. `;
    }

    if (general.mostProductiveDay && general.mostProductiveDayCount) {
      const productiveDate = format(new Date(general.mostProductiveDay), 'd MMMM', {
        locale: ru,
      });
      text += ` Самым продуктивным днём ${
        general.mostProductiveDayCount === 1 ? 'стал' : 'стало'
      } <b>${productiveDate}</b>, когда было предложено <b>${
        general.mostProductiveDayCount
      }</b> ${this.getPostsWord(general.mostProductiveDayCount)}.`;
    }

    // Добавляем статистику по месяцам
    if (general.mostActiveMonth && general.mostActiveMonthCount) {
      text += ` Самым активным месяцем ${
        general.mostActiveMonthCount === 1 ? 'стал' : 'стали'
      } <b>${general.mostActiveMonth}</b> с <b>${
        general.mostActiveMonthCount
      }</b> ${this.getPostsWord(general.mostActiveMonthCount)}`;

      if (general.leastActiveMonth && general.leastActiveMonthCount) {
        text += `, а самым спокойным — <b>${general.leastActiveMonth}</b> с <b>${
          general.leastActiveMonthCount
        }</b> ${this.getPostsWord(general.leastActiveMonthCount)}`;
      }
      text += `.`;
    }

    // Добавляем статистику по времени публикации (кроме NEXT_INTERVAL)
    if (
      general.mostPopularPublicationMode &&
      general.mostPopularPublicationMode !== 'NEXT_INTERVAL'
    ) {
      text += ` Чаще всего посты публиковались в режиме <b>${general.mostPopularPublicationMode}</b>.`;
    }

    // Добавляем статистику по дубликатам
    if (general.duplicatesPercentage !== undefined && general.duplicatesPercentage > 0) {
      text += ` <b>${general.duplicatesPercentage}%</b> предложенных постов ${
        general.duplicatesPercentage === 1 ? 'оказался' : 'оказались'
      } дубликатами`;

      if (general.topDuplicateUser && general.topDuplicateUser.duplicatesCount > 0) {
        text += `, причём у одного автора <b>${
          general.topDuplicateUser.duplicatesPercentage
        }%</b> ${general.topDuplicateUser.duplicatesPercentage === 1 ? 'был' : 'были'} дубликатами`;
      }
      text += `.`;
    }

    // Добавляем обезличенные данные о лидерах
    if (users.length > 0) {
      text += `\n`;

      // Лидер по публикациям
      const topPublisher = users.reduce((max, user) =>
        user.totalPublished > max.totalPublished ? user : max
      );
      if (topPublisher.totalPublished > 0) {
        text += `\n\nСреди нас есть настоящий мемный мастер — <b>${
          topPublisher.totalPublished
        }</b> ${this.getPostsWord(topPublisher.totalPublished)} от одного автора ${
          topPublisher.totalPublished === 1 ? 'был опубликован' : 'были опубликованы'
        }!`;
      }

      // Лидер по кринжу
      const topCringe = users.reduce((max, user) =>
        user.totalCringe > max.totalCringe ? user : max
      );
      if (topCringe.totalCringe > 0) {
        text += `\n\nЕсть и настоящий кринж-кинг — <b>${
          topCringe.totalCringe
        }</b> ${this.getPostsWord(topCringe.totalCringe)} от одного автора ${
          topCringe.totalCringe === 1 ? 'попал' : 'попали'
        } в кринж.`;
      }

      // Автор в синергии (лучшее соотношение публикаций к предложенным)
      const synergy = users
        .filter((u) => u.totalProposed >= 10) // Минимум 10 постов для статистики
        .map((u) => ({
          user: u,
          ratio: (u.totalPublished / u.totalProposed) * 100,
        }))
        .sort((a, b) => b.ratio - a.ratio)[0];

      if (synergy && synergy.ratio >= 70) {
        text += `\n\nЕсть автор, который попал в настоящую синергию с каналом — <b>${Math.round(
          synergy.ratio
        )}%</b> его ${this.getPostsWord(synergy.user.totalProposed)} ${
          synergy.user.totalProposed === 1 ? 'попадает' : 'попадают'
        } в публикацию!`;
      }

      // Самый упорный (наихудшее соотношение публикаций к предложенным)
      const persistent = users
        .filter((u) => u.totalProposed >= 10 && u.totalPublished > 0) // Минимум 10 постов и хотя бы 1 опубликован
        .map((u) => ({
          user: u,
          ratio: (u.totalPublished / u.totalProposed) * 100,
        }))
        .sort((a, b) => a.ratio - b.ratio)[0];

      if (persistent && persistent.ratio < 50) {
        text += `\n\nЕсть очень упорный подписчик — только <b>${Math.round(
          persistent.ratio
        )}%</b> его ${this.getPostsWord(persistent.user.totalProposed)} ${
          persistent.user.totalPublished === 1 ? 'публикуется' : 'публикуются'
        }, но он не сдаётся и продолжает!`;
      }
    }

    text += `\n\n Спасибо вам, что провели этот год с мемами! Без вас этот год был бы гораздо хуже ❤️\n\n`;
    text += `#итоги_года`;

    return text;
  }

  /**
   * Публикует общую статистику в канал
   */
  public async publishGeneralStatistics(year: number): Promise<void> {
    const { general, users } = await this.getYearResults(year);
    const text = this.formatGeneralStatistics(general, users);

    const me = await this.bot.api.getMe();
    const inlineKeyboard = new InlineKeyboard().url('Прислать пост', `https://t.me/${me.username}`);

    await this.bot.api.sendMessage(this.baseConfigService.memeChanelId, text, {
      reply_markup: inlineKeyboard,
      parse_mode: 'HTML',
    });

    this.logger.log(`General statistics published for year ${year}`);
  }

  /**
   * Отправляет персональную статистику пользователям с задержками и обработкой ошибок
   */
  public async publishPersonalStatistics(year: number): Promise<void> {
    // Получаем только неопубликованные результаты
    const savedResults = await this.yearResultRepository.find({
      where: { year, isPublished: false },
      order: { totalProposed: 'DESC' },
    });

    if (savedResults.length === 0) {
      this.logger.log(`No unpublished results found for year ${year}`);
      return;
    }

    // Получаем всех пользователей для расчета процентиля
    const allResults = await this.yearResultRepository.find({
      where: { year },
      order: { totalPublished: 'DESC' },
    });

    const users: UserYearStatistics[] = savedResults.map((result) => ({
      userId: result.userId,
      username: result.username,
      firstName: result.firstName,
      lastName: result.lastName,
      totalProposed: result.totalProposed,
      totalPublished: result.totalPublished,
      totalRejected: result.totalRejected,
      totalCringe: result.totalCringe,
      firstProposalDate: result.firstProposalDate,
      activeDays: result.activeDays,
      longestStreak: result.longestStreak,
      mostProductiveDay: result.mostProductiveDay,
      mostProductiveDayCount: result.mostProductiveDayCount,
      approvalRate: result.approvalRate,
      averageTimeToPublication: result.averageTimeToPublication,
      mostActiveTimeOfDay: result.mostActiveTimeOfDay,
      duplicatesCount: result.duplicatesCount,
      duplicatesPercentage: result.duplicatesPercentage,
    }));

    let successCount = 0;
    let blockedCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        // Вычисляем позицию пользователя в рейтинге по опубликованным мемам
        const userPosition = allResults.findIndex((r) => r.userId === user.userId) + 1;
        const percentile = Math.round(
          ((allResults.length - userPosition + 1) / allResults.length) * 100
        );

        const text = this.formatPersonalMessage(user, year, percentile, allResults.length);

        // Пытаемся отправить с повторными попытками при временных ошибках
        const maxRetries = 3;
        let attempt = 0;
        let sent = false;

        while (attempt < maxRetries && !sent) {
          try {
            await this.bot.api.sendMessage(user.userId, text, {
              parse_mode: 'HTML',
            });
            sent = true;
            successCount++;

            // Отмечаем как опубликованное
            await this.yearResultRepository.update(
              { year, userId: user.userId },
              { isPublished: true, publishedAt: new Date() }
            );

            this.logger.log(`Personal statistics sent to user ${user.userId}`);
          } catch (sendError) {
            attempt++;

            // Проверяем, заблокировал ли пользователь бота
            if (
              sendError.message?.includes('bot was blocked by the user') ||
              sendError.message?.includes('user is deactivated') ||
              sendError.message?.includes("bot can't initiate conversation")
            ) {
              this.logger.warn(
                `User ${user.userId} has blocked the bot or is deactivated. Marking as published to skip.`
              );
              blockedCount++;

              // Отмечаем как опубликованное, чтобы не пытаться отправить снова
              await this.yearResultRepository.update(
                { year, userId: user.userId },
                { isPublished: true, publishedAt: new Date() }
              );
              break;
            }

            // Для других ошибок пытаемся повторить
            if (attempt < maxRetries) {
              this.logger.warn(
                `Failed to send to user ${user.userId}, attempt ${attempt}/${maxRetries}. Retrying...`
              );
              // Увеличиваем задержку с каждой попыткой (exponential backoff)
              await this.delay(1000 * attempt);
            } else {
              throw sendError;
            }
          }
        }

        // Задержка между отправками для избежания rate limits (1.5 секунды)
        await this.delay(1500);
      } catch (error) {
        errorCount++;
        this.logger.error(
          `Failed to send statistics to user ${user.userId} after all retries:`,
          error
        );
        // Не отмечаем как опубликованное, чтобы можно было повторить позже
      }
    }

    this.logger.log(
      `Personal statistics publishing completed: ${successCount} sent, ${blockedCount} blocked, ${errorCount} errors`
    );
  }

  /**
   * Вспомогательная функция для задержки
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Форматирует имя пользователя
   */
  private formatUserName(user: UserYearStatistics): string {
    if (user.username) {
      return `@${user.username}`;
    }
    return [user.firstName, user.lastName].filter((item) => !!item).join(' ');
  }

  /**
   * Генерирует и отправляет preview итогов года владельцу бота
   */
  public async generateAndSendPreviewToOwner(year: number): Promise<void> {
    try {
      this.logger.log(`Generating year results preview for ${year}`);

      const preview = await this.generateYearResults(year);
      const previewText = this.formatPreviewMessage(preview);

      const ownerId = this.baseConfigService.ownerId;

      await this.bot.api.sendMessage(ownerId, previewText, {
        parse_mode: 'HTML',
      });

      this.logger.log(`Year results preview sent to owner (${ownerId})`);
    } catch (error) {
      this.logger.error(`Failed to generate and send year results preview:`, error);
      throw error;
    }
  }

  /**
   * Форматирует предпросмотр результатов для админа
   */
  public formatPreviewMessage(preview: YearResultsPreview): string {
    let text = `📊 <b>Предпросмотр итогов ${preview.general.year} года</b>\n\n`;

    text += `<b>Общая статистика:</b>\n`;
    text += `• Всего постов: ${preview.general.totalMemes}\n`;
    text += `• Постов от людей: ${preview.general.memesFromUsers}\n`;
    text += `• Попало в кринж: ${preview.general.cringeMemes}\n`;
    text += `• Найдено дубликатов: ${preview.general.duplicatesFound}\n\n`;

    text += `<b>Пользователи (${preview.users.length}):</b>\n`;
    for (let i = 0; i < Math.min(preview.users.length, 10); i++) {
      const user = preview.users[i];
      text += `${i + 1}. ${this.formatUserName(user)} - ${user.totalProposed} постов\n`;
    }

    if (preview.users.length > 10) {
      text += `... и еще ${preview.users.length - 10} пользователей\n`;
    }

    return text;
  }

  /**
   * Форматирует детальную информацию о пользователе
   */
  public formatUserDetailMessage(user: UserYearStatistics, year: number): string {
    let text = `👤 <b>${this.formatUserName(user)}</b>\n\n`;
    text += `📊 <b>Статистика за ${year} год:</b>\n`;
    text += `• Предложено постов: ${user.totalProposed}\n`;
    text += `• Опубликовано: ${user.totalPublished}\n`;
    text += `• Отклонено: ${user.totalRejected}\n`;
    text += `• Попало в кринж: ${user.totalCringe}\n`;
    text += `• Активных дней: ${user.activeDays}\n`;
    text += `• Самая длинная серия: ${user.longestStreak} ${this.getDaysWord(
      user.longestStreak
    )}\n`;

    // Проверяем что дата валидна
    if (user.firstProposalDate && !isNaN(new Date(user.firstProposalDate).getTime())) {
      text += `• Первый пост: ${format(new Date(user.firstProposalDate), 'd MMMM yyyy', {
        locale: ru,
      })}\n`;
    }

    return text;
  }

  /**
   * Форматирует персональное сообщение для пользователя
   */
  private formatPersonalMessage(
    user: UserYearStatistics,
    year: number,
    percentile: number,
    totalUsers: number
  ): string {
    let text = `<b>Твои итоги ${year} года 🎉</b>\n\n`;

    // Проверяем что дата валидна
    if (user.firstProposalDate && !isNaN(new Date(user.firstProposalDate).getTime())) {
      const firstDate = format(new Date(user.firstProposalDate), 'd MMMM', { locale: ru });
      const daysFromStart = differenceInDays(new Date(), new Date(user.firstProposalDate));

      text += `Первый пост ты предложил ${firstDate}. С тех пор прошло ${daysFromStart} ${this.getDaysWord(
        daysFromStart
      )}, и за это время ты предложил <b>${user.totalProposed}</b> ${this.getPostsWord(
        user.totalProposed
      )}. `;
    } else {
      text += `За этот год ты предложил <b>${user.totalProposed}</b> ${this.getPostsWord(
        user.totalProposed
      )}. `;
    }

    text += `Из них <b>${user.totalPublished}</b> ${this.getPostsWord(user.totalPublished)} ${
      user.totalPublished === 1 ? 'был опубликован' : 'были опубликованы'
    }. `;

    // Добавляем информацию о кринже, если есть
    if (user.totalCringe > 0) {
      text += `<b>${user.totalCringe}</b> ${this.getPostsWord(user.totalCringe)} ${
        user.totalCringe === 1 ? 'попал' : 'попали'
      } в кринж. `;
    }

    if (user.activeDays > 0) {
      text += `<b>${user.activeDays}</b> ${this.getDaysWord(
        user.activeDays
      )} в году ты присылал посты`;

      if (user.longestStreak > 1) {
        text += `, а твоя самая длинная серия составила <b>${
          user.longestStreak
        }</b> ${this.getDaysWord(user.longestStreak)} подряд`;
      }

      text += `. `;
    }

    // Добавляем информацию о самом продуктивном дне
    if (user.mostProductiveDay && user.mostProductiveDayCount && user.mostProductiveDayCount > 1) {
      const productiveDate = format(new Date(user.mostProductiveDay), 'd MMMM', { locale: ru });
      text += `В этот день (${productiveDate}) ты был на настоящей мемной волне и предложил <b>${
        user.mostProductiveDayCount
      }</b> ${this.getPostsWord(user.mostProductiveDayCount)}. `;
    }

    // Добавляем процент одобрения (только если > 0)
    if (user.approvalRate !== undefined && user.approvalRate > 0) {
      text += `\n\nТвой процент одобрения составил <b>${user.approvalRate}%</b>`;
      if (user.approvalRate >= 70) {
        text += ` — отличный результат!`;
      } else if (user.approvalRate >= 50) {
        text += ` — неплохо!`;
      } else {
        text += `, но не расстраивайся — главное участие!`;
      }
      text += ` `;
    }

    // Добавляем среднее время до публикации
    if (user.averageTimeToPublication !== undefined && user.averageTimeToPublication > 0) {
      const hours = user.averageTimeToPublication;
      if (hours < 24) {
        text += `В среднем твои посты публиковались через <b>${Math.round(
          hours
        )}</b> ${this.getHoursWord(Math.round(hours))}. `;
      } else {
        const days = Math.round(hours / 24);
        text += `В среднем твои посты публиковались через <b>${days}</b> ${this.getDaysWord(
          days
        )}. `;
      }
    }

    // Добавляем время суток
    if (user.mostActiveTimeOfDay) {
      text += `Чаще всего ты предлагал посты <b>${user.mostActiveTimeOfDay}</b>. `;
    }

    // Добавляем информацию о дубликатах
    if (user.duplicatesCount !== undefined && user.duplicatesCount > 0) {
      const showPercentage = user.duplicatesPercentage && user.duplicatesPercentage >= 1;

      text += `\n\nУ тебя было <b>${user.duplicatesCount}</b> ${this.getPostsWord(
        user.duplicatesCount
      )}-${user.duplicatesCount === 1 ? 'дубликат' : 'дубликатов'}`;

      if (showPercentage) {
        text += ` (<b>${user.duplicatesPercentage}%</b>)`;
      }

      if (user.duplicatesPercentage && user.duplicatesPercentage < 10) {
        text += ` — ты хорошо следишь за уникальностью контента!`;
      } else if (user.duplicatesPercentage && user.duplicatesPercentage >= 50) {
        text += ` — стоит проверять посты перед отправкой.`;
      }
      text += ` `;
    }

    text += `\n\nСпасибо, что был со мной в этом году 🙏`;

    return text;
  }

  /**
   * Возвращает правильное склонение слова "час"
   */
  private getHoursWord(count: number): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
      return 'часов';
    }

    if (lastDigit === 1) {
      return 'час';
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
      return 'часа';
    }

    return 'часов';
  }

  /**
   * Возвращает правильное склонение слова "день"
   */
  private getDaysWord(count: number): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
      return 'дней';
    }

    if (lastDigit === 1) {
      return 'день';
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
      return 'дня';
    }

    return 'дней';
  }

  /**
   * Возвращает правильное склонение слова "пост"
   */
  private getPostsWord(count: number): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
      return 'постов';
    }

    if (lastDigit === 1) {
      return 'пост';
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
      return 'поста';
    }

    return 'постов';
  }

  /**
   * Возвращает правильное склонение слова "автор"
   */
  private getAuthorsWord(count: number): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
      return 'авторов';
    }

    if (lastDigit === 1) {
      return 'автор';
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
      return 'автора';
    }

    return 'авторов';
  }
}
