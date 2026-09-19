import { differenceInDays, format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { formatUserName as formatDisplayName } from '../../../shared/display-name';
import { pluralizeRu } from '../../../shared/russian-plural';
import {
  UserYearStatistics,
  YearGeneralStatistics,
  YearResultsPreview,
} from '../interfaces/year-statistics.interface';

/**
 * Чистый форматтер итогов года.
 *
 * Все методы детерминированы, не обращаются к сети/БД и не хранят состояние:
 * собирают HTML-тексты итогов из переданных аргументов. Логика вынесена из
 * god-class `YearResultsService`, который оставляет у себя тонкие делегирующие
 * обёртки. Единственная внешняя зависимость — момент времени `now` для
 * `formatPersonalMessage`; он передаётся аргументом и не привязывает класс к
 * конкретным часам.
 */
export class YearResultsFormatter {
  /**
   * Форматирует общую статистику для публикации.
   *
   * @param general общие показатели за год
   * @param users срез пользовательских показателей для обезличенных лидеров
   * @returns HTML-текст общей статистики
   */
  public formatGeneralStatistics(
    general: YearGeneralStatistics,
    users: Pick<UserYearStatistics, 'totalProposed' | 'totalPublished' | 'totalCringe'>[]
  ): string {
    const year = general.year;
    let text = `🎉 <b>Итоги ${year} года</b>\n\n`;

    // Основная статистика: всего постов в канале
    text += `За этот год в канале было опубликовано <b>${
      general.totalMemes
    }</b> ${YearResultsFormatter.getPostsWord(general.totalMemes)}. `;

    // Статистика по обсерватории
    if (general.memesFromObservatory > 0) {
      const observatoryPercent = Math.round(
        (general.memesFromObservatory / general.totalMemes) * 100
      );
      text += `Из них <b>${general.memesFromObservatory}</b> ${YearResultsFormatter.getPostsWord(
        general.memesFromObservatory
      )} (<b>${observatoryPercent}%</b>) ${
        general.memesFromObservatory === 1 ? 'был найден' : 'были найдены'
      } обсерваторией. `;
    }

    // Статистика по пользовательским постам
    if (general.totalProposedByUsers > 0) {
      text += `Пользователи предложили <b>${general.totalProposedByUsers}</b> ${YearResultsFormatter.getPostsWord(
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

    // Текстовые сообщения админу
    if (general.textMessagesToAdmin > 0) {
      text += `Админу ${general.textMessagesToAdmin === 1 ? 'написали' : 'написали'} <b>${
        general.textMessagesToAdmin
      }</b> ${YearResultsFormatter.getTimesWord(general.textMessagesToAdmin)}`;

      if (general.adminRepliedToMessages > 0) {
        text += `, на <b>${general.adminRepliedToMessages}</b> ${
          general.adminRepliedToMessages === 1
            ? 'обращение'
            : YearResultsFormatter.getAppealWord(general.adminRepliedToMessages)
        } админ дал ответ (<b>${general.adminReplyPercentage}%</b>)`;
      }

      text += `. `;
    }

    // Количество авторов
    if (general.totalAuthors > 0) {
      text += `<b>${general.totalAuthors}</b> ${YearResultsFormatter.getAuthorsWord(general.totalAuthors)} ${
        general.totalAuthors === 1 ? 'создавал' : 'создавали'
      } контент для канала. `;
    }

    // Активные дни
    if (general.activeDaysWithMemes > 0) {
      text += `Посты предлагались в течение <b>${
        general.activeDaysWithMemes
      }</b> ${YearResultsFormatter.getDaysWord(general.activeDaysWithMemes)}`;
    }

    // Кринж и дубликаты
    const hasCringeOrDuplicates = general.cringeMemes > 0 || general.duplicatesFound > 0;

    if (hasCringeOrDuplicates) {
      text += `. `;

      if (general.cringeMemes > 0) {
        text += `<b>${general.cringeMemes}</b> ${YearResultsFormatter.getPostsWord(general.cringeMemes)} ${
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
      }</b> ${YearResultsFormatter.getPostsWord(general.mostProductiveDayCount)}.`;
    }

    // Добавляем статистику по месяцам
    if (general.mostActiveMonth && general.mostActiveMonthCount) {
      text += ` Самым активным месяцем ${
        general.mostActiveMonthCount === 1 ? 'стал' : 'стали'
      } <b>${general.mostActiveMonth}</b> с <b>${
        general.mostActiveMonthCount
      }</b> ${YearResultsFormatter.getPostsWord(general.mostActiveMonthCount)}`;

      if (general.leastActiveMonth && general.leastActiveMonthCount) {
        text += `, а самым спокойным — <b>${general.leastActiveMonth}</b> с <b>${
          general.leastActiveMonthCount
        }</b> ${YearResultsFormatter.getPostsWord(general.leastActiveMonthCount)}`;
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

    // Общее количество через модерацию (перед временными метриками)
    if (general.totalModeratedMessages > 0) {
      text += `\n\nЧерез модерацию прошло <b>${
        general.totalModeratedMessages
      }</b> ${YearResultsFormatter.getPostsWord(
        general.totalModeratedMessages
      )} — ваших обращений, предложенных постов и постов обсерватории.`;
    }

    // Добавляем статистику по времени модерации и публикации
    if (
      general.averageTimeToModeration !== undefined ||
      general.averageTimeFromModerationToPublication !== undefined
    ) {
      text += `\n\n`;

      if (general.averageTimeToModeration !== undefined) {
        const minutes = general.averageTimeToModeration;
        if (minutes < 60) {
          text += `В среднем админ принимал решение публиковать или нет за <b>${minutes}</b> ${YearResultsFormatter.getMinutesWord(
            minutes
          )}. `;
        } else {
          const hours = Math.round(minutes / 60);
          text += `В среднем админ принимал решение публиковать или нет за <b>${hours}</b> ${YearResultsFormatter.getHoursWord(
            hours
          )}. `;
        }
      }

      if (general.averageTimeFromModerationToPublication !== undefined) {
        const hours = general.averageTimeFromModerationToPublication;
        if (hours < 24) {
          text += `От момента принятия решения до публикации в среднем проходило <b>${hours}</b> ${YearResultsFormatter.getHoursWord(
            hours
          )}.`;
        } else {
          const days = Math.floor(hours / 24);
          const remainingHours = hours % 24;
          text += `От момента принятия решения до публикации в среднем проходило <b>${days}</b> ${YearResultsFormatter.getDaysWord(
            days
          )}`;
          if (remainingHours > 0) {
            text += ` и <b>${remainingHours}</b> ${YearResultsFormatter.getHoursWord(remainingHours)}`;
          }
          text += `.`;
        }
      }

      // Самая длинная очередь
      if (general.longestQueueDate && general.longestQueueLength) {
        const queueDate = format(new Date(general.longestQueueDate), 'd MMMM', { locale: ru });
        text += ` Самая длинная очередь на публикацию была <b>${queueDate}</b> — <b>${
          general.longestQueueLength
        }</b> ${YearResultsFormatter.getPostsWord(general.longestQueueLength)} ${
          general.longestQueueLength === 1 ? 'ожидал' : 'ожидали'
        } своей очереди.`;
      }
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
        }</b> ${YearResultsFormatter.getPostsWord(topPublisher.totalPublished)} от одного автора ${
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
        }</b> ${YearResultsFormatter.getPostsWord(topCringe.totalCringe)} от одного автора ${
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
        )}%</b> его ${YearResultsFormatter.getPostsWord(synergy.user.totalProposed)} ${
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
        )}%</b> его ${YearResultsFormatter.getPostsWord(persistent.user.totalProposed)} ${
          persistent.user.totalPublished === 1 ? 'публикуется' : 'публикуются'
        }, но он не сдаётся и продолжает!`;
      }

      // Информация о персональных итогах
      text += `\n\n<b>${users.length}</b> ${
        users.length === 1 ? 'человеку были' : 'людям были'
      } отправлены персональные итоги года через бота`;
    }

    text += `\n\nСпасибо вам, что провели этот год с мемами! Без вас этот год был бы гораздо хуже ❤️\n\n`;
    text += `#итоги_года`;

    return text;
  }

  /**
   * Форматирует предпросмотр результатов для админа.
   *
   * @param preview сгенерированные общие и персональные итоги
   * @returns HTML-текст предпросмотра
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
   * Форматирует детальную информацию о пользователе.
   *
   * @param user персональная статистика
   * @param year отчётный год
   * @returns HTML-текст с деталями
   */
  public formatUserDetailMessage(user: UserYearStatistics, year: number): string {
    let text = `👤 <b>${this.formatUserName(user)}</b>\n\n`;
    text += `📊 <b>Статистика за ${year} год:</b>\n`;
    text += `• Предложено постов: ${user.totalProposed}\n`;
    text += `• Опубликовано: ${user.totalPublished}\n`;
    text += `• Отклонено: ${user.totalRejected}\n`;
    text += `• Попало в кринж: ${user.totalCringe}\n`;
    text += `• Активных дней: ${user.activeDays}\n`;
    text += `• Самая длинная серия: ${user.longestStreak} ${YearResultsFormatter.getDaysWord(
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
   * Форматирует персональное сообщение для пользователя.
   *
   * @param user персональная статистика
   * @param year отчётный год
   * @param _percentile процентиль (не используется в тексте)
   * @param _totalUsers всего пользователей (не используется в тексте)
   * @param now текущий момент для расчёта «сколько прошло с первого поста»
   * @returns HTML-текст персонального сообщения
   */
  public formatPersonalMessage(
    user: UserYearStatistics,
    year: number,
    _percentile: number,
    _totalUsers: number,
    now: Date
  ): string {
    let text = `<b>Твои итоги ${year} года 🎉</b>\n\n`;

    // Проверяем что дата валидна
    if (user.firstProposalDate && !isNaN(new Date(user.firstProposalDate).getTime())) {
      const firstDate = format(new Date(user.firstProposalDate), 'd MMMM', { locale: ru });
      const daysFromStart = differenceInDays(now, new Date(user.firstProposalDate));

      text += `Первый пост ты предложил ${firstDate}. С тех пор прошло ${daysFromStart} ${YearResultsFormatter.getDaysWord(
        daysFromStart
      )}, и за это время ты предложил <b>${user.totalProposed}</b> ${YearResultsFormatter.getPostsWord(
        user.totalProposed
      )}. `;
    } else {
      text += `За этот год ты предложил <b>${user.totalProposed}</b> ${YearResultsFormatter.getPostsWord(
        user.totalProposed
      )}. `;
    }

    text += `Из них <b>${user.totalPublished}</b> ${YearResultsFormatter.getPostsWord(user.totalPublished)} ${
      user.totalPublished === 1 ? 'был опубликован' : 'были опубликованы'
    }. `;

    // Добавляем информацию о кринже, если есть
    if (user.totalCringe > 0) {
      text += `<b>${user.totalCringe}</b> ${YearResultsFormatter.getPostsWord(user.totalCringe)} ${
        user.totalCringe === 1 ? 'попал' : 'попали'
      } в кринж. `;
    }

    if (user.activeDays > 0) {
      text += `<b>${user.activeDays}</b> ${YearResultsFormatter.getDaysWord(
        user.activeDays
      )} в году ты присылал посты`;

      if (user.longestStreak > 1) {
        text += `, а твоя самая длинная серия составила <b>${
          user.longestStreak
        }</b> ${YearResultsFormatter.getDaysWord(user.longestStreak)} подряд`;
      }

      text += `. `;
    }

    // Добавляем информацию о самом продуктивном дне
    if (user.mostProductiveDay && user.mostProductiveDayCount && user.mostProductiveDayCount > 1) {
      const productiveDate = format(new Date(user.mostProductiveDay), 'd MMMM', { locale: ru });
      text += `В этот день (${productiveDate}) ты был на настоящей мемной волне и предложил <b>${
        user.mostProductiveDayCount
      }</b> ${YearResultsFormatter.getPostsWord(user.mostProductiveDayCount)}. `;
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
        )}</b> ${YearResultsFormatter.getHoursWord(Math.round(hours))}. `;
      } else {
        const days = Math.round(hours / 24);
        text += `В среднем твои посты публиковались через <b>${days}</b> ${YearResultsFormatter.getDaysWord(
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

      text += `\n\nУ тебя было <b>${user.duplicatesCount}</b> ${YearResultsFormatter.getPostsWord(
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
   * Форматирует имя пользователя.
   *
   * @param user пользователь с полями имени
   * @returns `@username` либо «Имя Фамилия»
   */
  private formatUserName(user: UserYearStatistics): string {
    return formatDisplayName(user);
  }

  /**
   * Возвращает правильное склонение слова "час".
   *
   * @param count количество часов
   * @returns одна из форм слова
   */
  public static getHoursWord(count: number): string {
    return pluralizeRu(count, ['час', 'часа', 'часов']);
  }

  /**
   * Возвращает правильное склонение слова "день".
   *
   * @param count количество дней
   * @returns одна из форм слова
   */
  public static getDaysWord(count: number): string {
    return pluralizeRu(count, ['день', 'дня', 'дней']);
  }

  /**
   * Возвращает правильное склонение слова "пост".
   *
   * @param count количество постов
   * @returns одна из форм слова
   */
  public static getPostsWord(count: number): string {
    return pluralizeRu(count, ['пост', 'поста', 'постов']);
  }

  /**
   * Возвращает правильное склонение слова "минута".
   *
   * @param count количество минут
   * @returns одна из форм слова
   */
  public static getMinutesWord(count: number): string {
    return pluralizeRu(count, ['минуту', 'минуты', 'минут']);
  }

  /**
   * Возвращает правильное склонение слова "автор".
   *
   * @param count количество авторов
   * @returns одна из форм слова
   */
  public static getAuthorsWord(count: number): string {
    return pluralizeRu(count, ['автор', 'автора', 'авторов']);
  }

  /**
   * Возвращает правильное склонение слова "раз".
   *
   * @param count количество раз
   * @returns одна из форм слова
   */
  public static getTimesWord(count: number): string {
    return pluralizeRu(count, ['раз', 'раза', 'раз']);
  }

  /**
   * Возвращает правильное склонение слова "обращение".
   *
   * @param count количество обращений
   * @returns одна из форм слова
   */
  public static getAppealWord(count: number): string {
    return pluralizeRu(count, ['обращение', 'обращения', 'обращений']);
  }
}
