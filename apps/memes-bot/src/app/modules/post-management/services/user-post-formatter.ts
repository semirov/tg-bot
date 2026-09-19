/**
 * Минимальное описание автора сообщения Telegram, нужное для текстов заявок.
 */
export interface PostAuthorDisplay {
  /** Имя. */
  first_name: string;
  /** Фамилия (может отсутствовать). */
  last_name?: string | null;
  /** Username без `@` (может отсутствовать). */
  username?: string | null;
  /** Признак бота. */
  is_bot?: boolean | null;
  /** Признак премиум-аккаунта. */
  is_premium?: boolean | null;
}

/**
 * Флаги статуса заявки, влияющие на сообщение о дубликате по `fileUniqueId`.
 */
export interface DuplicateStatusFlags {
  /** Пост уже опубликован. */
  isPublished?: boolean | null;
  /** Пост одобрен (`true`), отклонён (`false`) или на модерации (`null`). */
  isApproved?: boolean | null;
}

/**
 * Чистые форматтеры текстов предложки.
 *
 * Все методы детерминированы, не обращаются к сети/БД и не хранят состояние:
 * собирают метки меню и пользовательские сообщения из переданных аргументов.
 * Логика вынесена из god-class `UserPostManagementService`, который оставляет у
 * себя тонкие обёртки-меню и методы-делегаты. Вывод обязан быть байт-в-байт
 * идентичен прежним строкам сервиса — на них опираются white-box и e2e-тесты.
 */
export class UserPostFormatter {
  /** Метка кнопки снятия лимита. */
  public static readonly LIFT_LIMIT_LABEL = '🔓 Снять лимит';

  /** Метка кнопки одобрения поста. */
  public static readonly APPROVE_LABEL = '👍 Одобрить';

  /** Метка кнопки отклонения поста. */
  public static readonly REJECT_LABEL = '👎 Отклонить';

  /** Метка подтверждения дубликата. */
  public static readonly DUPLICATE_CONFIRM_LABEL = '✅ Дубликат';

  /** Метка отрицания дубликата. */
  public static readonly DUPLICATE_DENY_LABEL = '❌ Не дубликат';

  /** Метка кнопки возврата. */
  public static readonly BACK_LABEL = 'Назад';

  /** Метка восстановления после отклонения. */
  public static readonly RESTORE_LABEL = '🔁';

  /** Метка перехода к бану. */
  public static readonly BAN_LABEL = '💀';

  /** Метка подтверждения бана. */
  public static readonly BAN_CONFIRM_LABEL = 'Точно в бан?';

  /** Метка отрицания в подтверждениях. */
  public static readonly NO_LABEL = 'Нет';

  /** Метка подтверждения страйка. */
  public static readonly STRIKE_CONFIRM_LABEL = 'Точно добавить страйк?';

  /** Метка режима «Кринж». */
  public static readonly PUBLISH_NIGHT_CRINGE_LABEL = 'Кринж';

  /** Метка режима «Сейчас». */
  public static readonly PUBLISH_NOW_LABEL = 'Сейчас';

  /** Метка режима «Ближайший слот». */
  public static readonly PUBLISH_NEXT_INTERVAL_LABEL = 'Ближайший слот';

  /** Метка режима «Ночью». */
  public static readonly PUBLISH_NIGHT_LABEL = 'Ночью';

  /** Метка режима «Утром». */
  public static readonly PUBLISH_MORNING_LABEL = 'Утром';

  /** Метка режима «Днем». */
  public static readonly PUBLISH_MIDDAY_LABEL = 'Днем';

  /** Метка режима «Вечером». */
  public static readonly PUBLISH_EVENING_LABEL = 'Вечером';

  /**
   * Текст обращения пользователя в канал запросов.
   *
   * @param from автор сообщения
   * @returns строка вида `📝 Обращение от 👑 🤖 Иван Петров @ivan`
   */
  public textRequestText(from: PostAuthorDisplay): string {
    return this.describeAuthor('📝 Обращение от', from);
  }

  /**
   * Текст заявки-мема в канал запросов.
   *
   * @param from автор сообщения
   * @returns строка вида `Пост от 👑 🤖 Иван Петров @ivan #предложка`
   */
  public memeRequestText(from: PostAuthorDisplay): string {
    return `${this.describeAuthor('Пост от', from)} \n#предложка`;
  }

  /**
   * Подтверждение получения текстового обращения, когда реакция не поставилась.
   *
   * @returns сообщение пользователю
   */
  public requestReactionAckText(): string {
    return 'Мы получили твоё обращение и скоро ответим';
  }

  /**
   * Подтверждение получения мема, когда реакция не поставилась.
   *
   * @returns сообщение пользователю
   */
  public requestReceivedText(): string {
    return 'Мы все получили и скоро ответим';
  }

  /**
   * Пояснение к пересланному сообщению, на которое ответил пользователь.
   *
   * @returns сообщение в канал запросов
   */
  public adminReplyHintText(): string {
    return '👆 Пользователь ответил на это сообщение:';
  }

  /**
   * Пояснение, когда исходное сообщение не удалось переслать.
   *
   * @returns сообщение в канал запросов
   */
  public adminReplyForwardFailedText(): string {
    return 'Пользователь ответил на сообщение, но его не удалось переслать. Возможно, это слишком старое сообщение.';
  }

  /**
   * Сообщение о достижении суточного лимита.
   *
   * @param remainingTime человекочитаемое время до сброса лимита
   * @returns текст предупреждения
   */
  public limitReachedText(remainingTime: string): string {
    return `Ты можешь предложить максимум 5 постов в сутки\n\nНовый лимит будет доступен ${remainingTime}`;
  }

  /**
   * Сообщение о повторной отправке уже существующего поста.
   *
   * @param flags статус существующего поста
   * @returns сообщение пользователю
   */
  public duplicateStatusText(flags: DuplicateStatusFlags): string {
    let statusMessage = '';
    if (flags.isPublished) {
      statusMessage = 'Этот пост уже был опубликован ранее';
    } else if (flags.isApproved === true) {
      statusMessage = 'Этот пост уже прошел модерацию и находится в очереди на публикацию';
    } else if (flags.isApproved === false) {
      statusMessage = 'Этот пост уже был отклонен модераторами';
    } else {
      statusMessage = 'Этот пост уже находится на модерации';
    }

    return `${statusMessage} и не может быть опубликован повторно.`;
  }

  /**
   * Пометка о найденном опубликованном дубликате с процентом совпадения.
   *
   * @param percentage процент совпадения
   * @returns строка-приписка к тексту заявки
   */
  public publishedDuplicateNote(percentage: number): string {
    return `\n🔄 Возможный дубликат (совпадение ${percentage}%)`;
  }

  /**
   * Пометка о запланированном дубликате с датой публикации.
   *
   * @param percentage процент совпадения
   * @param formattedDate отформатированная дата
   * @returns строка-приписка к тексту заявки
   */
  public scheduledDuplicateOnDateNote(percentage: number, formattedDate: string): string {
    return `\n🕒 Похожий пост (${percentage}%) запланирован на ${formattedDate}`;
  }

  /**
   * Пометка о запланированном дубликате без даты (ошибка форматирования).
   *
   * @param percentage процент совпадения
   * @returns строка-приписка к тексту заявки
   */
  public scheduledDuplicateSoonNote(percentage: number): string {
    return `\n🕒 Похожий пост (${percentage}%) запланирован к публикации`;
  }

  /**
   * Подробность о запланированном дубликате с датой и обратным отсчётом.
   *
   * @param formattedDate отформатированная дата
   * @param timeDistance человекочитаемое расстояние до публикации
   * @param postId идентификатор запланированного поста
   * @returns сообщение в канал запросов
   */
  public scheduledDuplicateInfoText(
    formattedDate: string,
    timeDistance: string,
    postId: number
  ): string {
    return `👆 Похожий пост запланирован на ${formattedDate} (через ${timeDistance})\n\nID поста: ${postId}`;
  }

  /**
   * Подробность о запланированном дубликате без валидной даты.
   *
   * @param postId идентификатор запланированного поста
   * @returns сообщение в канал запросов
   */
  public scheduledDuplicateInfoSoonText(postId: number): string {
    return `👆 Похожий пост запланирован к публикации.\n\nID поста: ${postId}`;
  }

  /**
   * Уведомление модератору об успешном снятии лимита.
   *
   * @param originalText исходный текст сообщения
   * @param username username модератора
   * @returns обновлённый текст сообщения
   */
  public limitLiftedByModeratorText(originalText: string, username: string): string {
    return `${originalText}\n\n✅ Лимит снят модератором @${username}`;
  }

  /**
   * Уведомление пользователю о снятии лимита администратором.
   *
   * @returns сообщение пользователю
   */
  public limitLiftedForUserText(): string {
    return '✅ Админ снял для тебя ограничение на публикацию постов на текущие сутки. Можешь отправить этот пост еще раз.';
  }

  /**
   * Уведомление пользователю о запланированном дубликате с датой.
   *
   * @param formattedDate отформатированная дата публикации
   * @returns сообщение пользователю
   */
  public duplicateScheduledToUserText(formattedDate: string): string {
    return `Похожий пост уже запланирован к публикации ${formattedDate}.\nТы можешь предложить что-нибудь другое`;
  }

  /**
   * Уведомление пользователю о запланированном дубликате без даты.
   *
   * @returns сообщение пользователю
   */
  public duplicateScheduledSoonToUserText(): string {
    return 'Похожий пост уже запланирован к публикации. Ты можешь предложить что-нибудь другое';
  }

  /**
   * Уведомление пользователю об опубликованном дубликате.
   *
   * @returns сообщение пользователю
   */
  public publishedDuplicateToUserText(): string {
    return 'Этот пост уже публиковался, ты можешь предложить что-нибудь другое';
  }

  /**
   * Уведомление пользователю об отклонении поста.
   *
   * @returns сообщение пользователю
   */
  public rejectedPostText(): string {
    return 'Мы не можем такое опубликовать, твой пост отклонен';
  }

  /**
   * Уведомление пользователю о восстановлении поста после отклонения.
   *
   * @returns сообщение пользователю
   */
  public restoredAfterRejectText(): string {
    return (
      'Мы передумали! 🤯\n\n' +
      'Такое иногда бывает, мы долго думали, смеяли пост со всех сторон, показывали его всем кому могли, ' +
      'в итоге он будет опубликован! 🎉\n' +
      'Прости что так поступили с тобой, в следующий раз мы будем внимательнее. 🥺\n' +
      'P.S. Тебе придет отдельное сообщение, когда пост будет опубликован 😉'
    );
  }

  /**
   * Уведомление пользователю о бане.
   *
   * @returns сообщение пользователю
   */
  public bannedUserText(): string {
    return (
      'К сожалению, мы вынуждены ограничить доступ к боту, т.к. ' +
      'ты серьезно нарушил правила публикации и нашего сообщества, ' +
      'нам жаль что пришлось применить столь серьезную меру, ' +
      'но у нас не осталось иного выхода.\n\n' +
      'Бот больше не будет реагировать на сообщения'
    );
  }

  /**
   * Обратная связь после немедленной публикации поста.
   *
   * @returns сообщение пользователю
   */
  public postPublishedText(): string {
    return 'Твой пост опубликован \n' + 'Присылай еще!\n';
  }

  /**
   * Обратная связь после немедленной публикации поста в рубрику «Кринж».
   *
   * @param cringeChannelLink HTML-ссылка на канал кринжа
   * @returns сообщение пользователю
   */
  public postPublishedNightCringeText(cringeChannelLink: string): string {
    return 'Твой пост опубликован \n' + `Утром пост будет перемещен в канал ${cringeChannelLink}`;
  }

  /**
   * Обратная связь после постановки поста в расписание.
   *
   * @param formattedDate отформатированная дата публикации
   * @returns сообщение пользователю
   */
  public postScheduledText(formattedDate: string): string {
    return `Твой пост будет опубликован ${formattedDate} ⏱\n\nПрисылай еще 😉️`;
  }

  /**
   * Обратная связь после постановки в расписание поста рубрики «Кринж».
   *
   * @param formattedDate отформатированная дата публикации
   * @param cringeChannelLink HTML-ссылка на канал кринжа
   * @returns сообщение пользователю
   */
  public postScheduledNightCringeText(formattedDate: string, cringeChannelLink: string): string {
    return (
      `Твой пост будет опубликован ${formattedDate} ⏱\n\n` +
      `Пост попал в особую рубрику, которая публикуется только ночью, а утром перемещается в отдельный канал: ${cringeChannelLink}\n` +
      'Присылай еще 😉️'
    );
  }

  /**
   * Поздравление с попаданием постов в лучшие за сутки.
   *
   * @param postsCount число лучших постов пользователя
   * @returns сообщение пользователю
   */
  public bestMemesText(postsCount: number): string {
    if (postsCount === 1) {
      return '🎉 Поздравляем! Твой пост стал одним из лучших за сутки!';
    }
    return '🎉 Поздравляем! Твои посты стали лучшими за сутки!';
  }

  /**
   * Динамическая метка кнопки «Опубликовать».
   *
   * @param username имя модератора
   * @returns метка кнопки
   */
  public publishButtonLabel(username: string): string {
    return `✅ Опубликовать (${username})`;
  }

  /**
   * Динамическая метка статистики отклонённых постов.
   *
   * @param total всего
   * @param week за неделю
   * @returns метка кнопки
   */
  public discardStatisticLabel(total: number, week: number): string {
    return `👎 ${total} (${week})`;
  }

  /**
   * Динамическая метка статистики одобренных постов.
   *
   * @param total всего
   * @param day за сутки
   * @returns метка кнопки
   */
  public approvedStatisticLabel(total: number, day: number): string {
    return `👍 ${total} (${day})`;
  }

  /**
   * Динамическая метка последней публикации.
   *
   * @param info человекочитаемое время
   * @returns метка кнопки
   */
  public lastPostLabel(info: string): string {
    return `🗓 ${info}`;
  }

  /**
   * Динамическая метка отклонённого поста с именем модератора.
   *
   * @param username имя модератора
   * @returns метка кнопки
   */
  public rejectedButtonLabel(username: string): string {
    return `👨 Отклонен ❌ (${username})`;
  }

  /**
   * Динамическая метка количества страйков.
   *
   * @param count количество страйков (может отсутствовать)
   * @returns метка кнопки
   */
  public strikesLabel(count: number | null | undefined): string {
    return `❗ ${count || 0}`;
  }

  /**
   * Динамическая метка запланированного времени публикации.
   *
   * @param dateFormatted отформатированная дата
   * @param username имя модератора
   * @returns метка кнопки
   */
  public scheduledTimeLabel(dateFormatted: string, username: string): string {
    return `⏰ ${dateFormatted} (${username})`;
  }

  /**
   * Динамическая метка опубликованного поста в канале.
   *
   * @param username имя модератора/пользователя
   * @returns метка кнопки
   */
  public publishedKeyboardLabel(username: string): string {
    return `👨 Опубликован (${username})`;
  }

  /**
   * Собирает префикс и флаги автора: премиум, бот, имя, username.
   *
   * @param prefix текстовый префикс (например «Пост от»)
   * @param from автор сообщения
   * @returns склеенная строка без лишних пробелов
   */
  private describeAuthor(prefix: string, from: PostAuthorDisplay): string {
    return [
      prefix,
      from.is_premium ? '👑' : null,
      from.is_bot ? '🤖' : null,
      from.first_name,
      from.last_name,
      from.username ? `@${from.username}` : null,
    ]
      .filter((value) => !!value)
      .join(' ');
  }
}
