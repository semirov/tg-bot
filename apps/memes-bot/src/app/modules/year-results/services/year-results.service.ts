import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
import { CLOCK, Clock } from '../../../shared/clock';
import { RANDOM, Random } from '../../../shared/random';
import { YearResultEntity } from '../entities/year-result.entity';
import {
  UserYearStatistics,
  YearGeneralStatistics,
  YearResultsPreview,
} from '../interfaces/year-statistics.interface';
import { YearResultsFormatter } from './year-results.formatter';
import { YearStatisticsQuery } from './year-statistics.query';

/**
 * Сервис сбора, хранения и публикации итогов года.
 *
 * После рефакторинга это тонкий фасад: сбор статистики вынесен в
 * {@link YearStatisticsQuery}, форматирование — в {@link YearResultsFormatter}.
 * Публичный API и приватные методы, к которым обращаются white-box спеки,
 * сохранены как делегирующие обёртки.
 */
@Injectable()
export class YearResultsService {
  private readonly logger = new Logger(YearResultsService.name);

  private readonly formatter: YearResultsFormatter;
  private readonly statisticsQuery: YearStatisticsQuery;

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
    private baseConfigService: BaseConfigService,
    @Inject(CLOCK) private clock: Clock,
    @Inject(RANDOM) private random: Random
  ) {
    this.formatter = new YearResultsFormatter();
    this.statisticsQuery = new YearStatisticsQuery(
      this.userRequestRepository,
      this.cringePostRepository,
      this.postSchedulerRepository,
      this.observatoryPostRepository
    );
  }

  /**
   * Собирает общую статистику за год.
   *
   * @param year отчётный год
   * @returns агрегированные общие показатели
   */
  public async collectGeneralStatistics(year: number): Promise<YearGeneralStatistics> {
    return this.statisticsQuery.collectGeneralStatistics(year);
  }

  /**
   * Собирает персональную статистику пользователей за год.
   * Только для пользователей с хотя бы 1 опубликованным постом.
   *
   * @param year отчётный год
   * @returns массив персональных показателей
   */
  public async collectUserStatistics(year: number): Promise<UserYearStatistics[]> {
    return this.statisticsQuery.collectUserStatistics(year);
  }

  /**
   * Генерирует и сохраняет результаты года.
   *
   * @param year отчётный год
   * @returns сгенерированные общие и персональные итоги
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
   * Получает сохраненные результаты года.
   *
   * @param year отчётный год
   * @returns общая статистика и сохранённые персональные итоги
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
   * Форматирует общую статистику для публикации.
   *
   * @param general общие показатели за год
   * @param users срез пользовательских показателей для лидеров
   * @returns HTML-текст общей статистики
   */
  public formatGeneralStatistics(
    general: YearGeneralStatistics,
    users: Pick<UserYearStatistics, 'totalProposed' | 'totalPublished' | 'totalCringe'>[]
  ): string {
    return this.formatter.formatGeneralStatistics(general, users);
  }

  /**
   * Публикует общую статистику в канал.
   *
   * @param year отчётный год
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
   * Отправляет персональную статистику пользователям с задержками и обработкой ошибок.
   *
   * @param year отчётный год
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
              { isPublished: true, publishedAt: this.clock.now() }
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
                { isPublished: true, publishedAt: this.clock.now() }
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
   * Вспомогательная функция для задержки.
   *
   * @param ms задержка в миллисекундах
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Генерирует и отправляет preview итогов года владельцу бота.
   *
   * @param year отчётный год
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
   * Форматирует предпросмотр результатов для админа.
   *
   * @param preview сгенерированные итоги
   * @returns HTML-текст предпросмотра
   */
  public formatPreviewMessage(preview: YearResultsPreview): string {
    return this.formatter.formatPreviewMessage(preview);
  }

  /**
   * Форматирует детальную информацию о пользователе.
   *
   * @param user персональная статистика
   * @param year отчётный год
   * @returns HTML-текст с деталями
   */
  public formatUserDetailMessage(user: UserYearStatistics, year: number): string {
    return this.formatter.formatUserDetailMessage(user, year);
  }

  /**
   * Форматирует персональное сообщение для пользователя.
   *
   * @param user персональная статистика
   * @param year отчётный год
   * @param percentile процентиль
   * @param totalUsers всего пользователей
   * @returns HTML-текст персонального сообщения
   */
  private formatPersonalMessage(
    user: UserYearStatistics,
    year: number,
    percentile: number,
    totalUsers: number
  ): string {
    return this.formatter.formatPersonalMessage(
      user,
      year,
      percentile,
      totalUsers,
      this.clock.now()
    );
  }

  /**
   * Возвращает правильное склонение слова "час".
   *
   * @param count количество
   * @returns форма слова
   */
  private getHoursWord(count: number): string {
    return YearResultsFormatter.getHoursWord(count);
  }

  /**
   * Возвращает правильное склонение слова "день".
   *
   * @param count количество
   * @returns форма слова
   */
  private getDaysWord(count: number): string {
    return YearResultsFormatter.getDaysWord(count);
  }

  /**
   * Возвращает правильное склонение слова "пост".
   *
   * @param count количество
   * @returns форма слова
   */
  private getPostsWord(count: number): string {
    return YearResultsFormatter.getPostsWord(count);
  }

  /**
   * Возвращает правильное склонение слова "минута".
   *
   * @param count количество
   * @returns форма слова
   */
  private getMinutesWord(count: number): string {
    return YearResultsFormatter.getMinutesWord(count);
  }

  /**
   * Возвращает правильное склонение слова "автор".
   *
   * @param count количество
   * @returns форма слова
   */
  private getAuthorsWord(count: number): string {
    return YearResultsFormatter.getAuthorsWord(count);
  }

  /**
   * Возвращает правильное склонение слова "раз".
   *
   * @param count количество
   * @returns форма слова
   */
  private getTimesWord(count: number): string {
    return YearResultsFormatter.getTimesWord(count);
  }

  /**
   * Возвращает правильное склонение слова "обращение".
   *
   * @param count количество
   * @returns форма слова
   */
  private getAppealWord(count: number): string {
    return YearResultsFormatter.getAppealWord(count);
  }
}
