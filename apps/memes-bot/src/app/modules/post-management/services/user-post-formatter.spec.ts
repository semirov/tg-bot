import { UserPostFormatter } from './user-post-formatter';

const fullAuthor = {
  first_name: 'Иван',
  last_name: 'Петров',
  username: 'ivan',
  is_bot: true,
  is_premium: true,
};

const plainAuthor = {
  first_name: 'Иван',
  last_name: null,
  username: null,
  is_bot: false,
  is_premium: false,
};

describe('UserPostFormatter', () => {
  let formatter: UserPostFormatter;

  beforeEach(() => {
    formatter = new UserPostFormatter();
  });

  it('объявляет метки меню', () => {
    expect(UserPostFormatter.LIFT_LIMIT_LABEL).toBe('🔓 Снять лимит');
    expect(UserPostFormatter.APPROVE_LABEL).toBe('👍 Одобрить');
    expect(UserPostFormatter.REJECT_LABEL).toBe('👎 Отклонить');
    expect(UserPostFormatter.DUPLICATE_CONFIRM_LABEL).toBe('✅ Дубликат');
    expect(UserPostFormatter.DUPLICATE_DENY_LABEL).toBe('❌ Не дубликат');
    expect(UserPostFormatter.BACK_LABEL).toBe('Назад');
    expect(UserPostFormatter.RESTORE_LABEL).toBe('🔁');
    expect(UserPostFormatter.BAN_LABEL).toBe('💀');
    expect(UserPostFormatter.BAN_CONFIRM_LABEL).toBe('Точно в бан?');
    expect(UserPostFormatter.NO_LABEL).toBe('Нет');
    expect(UserPostFormatter.STRIKE_CONFIRM_LABEL).toBe('Точно добавить страйк?');
    expect(UserPostFormatter.PUBLISH_NIGHT_CRINGE_LABEL).toBe('Кринж');
    expect(UserPostFormatter.PUBLISH_NOW_LABEL).toBe('Сейчас');
    expect(UserPostFormatter.PUBLISH_NEXT_INTERVAL_LABEL).toBe('Ближайший слот');
    expect(UserPostFormatter.PUBLISH_NIGHT_LABEL).toBe('Ночью');
    expect(UserPostFormatter.PUBLISH_MORNING_LABEL).toBe('Утром');
    expect(UserPostFormatter.PUBLISH_MIDDAY_LABEL).toBe('Днем');
    expect(UserPostFormatter.PUBLISH_EVENING_LABEL).toBe('Вечером');
  });

  describe('тексты заявок', () => {
    it('собирает текст обращения со всеми флагами', () => {
      expect(formatter.textRequestText(fullAuthor)).toBe(
        '📝 Обращение от 👑 🤖 Иван Петров @ivan'
      );
    });

    it('собирает текст обращения без флагов и username', () => {
      expect(formatter.textRequestText(plainAuthor)).toBe('📝 Обращение от Иван');
    });

    it('собирает текст мема со всеми флагами', () => {
      expect(formatter.memeRequestText(fullAuthor)).toBe(
        'Пост от 👑 🤖 Иван Петров @ivan \n#предложка'
      );
    });

    it('собирает текст мема без флагов и username', () => {
      expect(formatter.memeRequestText(plainAuthor)).toBe('Пост от Иван \n#предложка');
    });

    it('добавляет фамилию без username и без флагов', () => {
      expect(
        formatter.textRequestText({ first_name: 'Иван', last_name: 'Петров' })
      ).toBe('📝 Обращение от Иван Петров');
    });

    it('возвращает подтверждения и пояснения', () => {
      expect(formatter.requestReactionAckText()).toBe(
        'Мы получили твоё обращение и скоро ответим'
      );
      expect(formatter.requestReceivedText()).toBe('Мы все получили и скоро ответим');
      expect(formatter.adminReplyHintText()).toBe('👆 Пользователь ответил на это сообщение:');
      expect(formatter.adminReplyForwardFailedText()).toBe(
        'Пользователь ответил на сообщение, но его не удалось переслать. Возможно, это слишком старое сообщение.'
      );
    });
  });

  describe('лимит и дубликаты', () => {
    it('строит сообщение о лимите', () => {
      expect(formatter.limitReachedText('через 3 часа')).toBe(
        'Ты можешь предложить максимум 5 постов в сутки\n\nНовый лимит будет доступен через 3 часа'
      );
    });

    it.each([
      [{ isPublished: true, isApproved: null }, 'Этот пост уже был опубликован ранее'],
      [{ isPublished: false, isApproved: true }, 'Этот пост уже прошел модерацию и находится в очереди на публикацию'],
      [{ isPublished: false, isApproved: false }, 'Этот пост уже был отклонен модераторами'],
      [{ isPublished: false, isApproved: null }, 'Этот пост уже находится на модерации'],
    ])('строит статус дубликата (%j)', (flags, expected) => {
      expect(formatter.duplicateStatusText(flags)).toBe(
        `${expected} и не может быть опубликован повторно.`
      );
    });

    it('строит пометки о дубликатах', () => {
      expect(formatter.publishedDuplicateNote(90)).toBe(
        '\n🔄 Возможный дубликат (совпадение 90%)'
      );
      expect(formatter.scheduledDuplicateOnDateNote(70, '01.05.26 в ~10:00')).toBe(
        '\n🕒 Похожий пост (70%) запланирован на 01.05.26 в ~10:00'
      );
      expect(formatter.scheduledDuplicateSoonNote(70)).toBe(
        '\n🕒 Похожий пост (70%) запланирован к публикации'
      );
    });

    it('строит подробности о запланированном дубликате', () => {
      expect(formatter.scheduledDuplicateInfoText('01.05.26 в ~10:00', '3 часа', 3)).toBe(
        '👆 Похожий пост запланирован на 01.05.26 в ~10:00 (через 3 часа)\n\nID поста: 3'
      );
      expect(formatter.scheduledDuplicateInfoSoonText(3)).toBe(
        '👆 Похожий пост запланирован к публикации.\n\nID поста: 3'
      );
    });

    it('строит уведомления о снятии лимита', () => {
      expect(formatter.limitLiftedByModeratorText('текст', 'mod')).toBe(
        'текст\n\n✅ Лимит снят модератором @mod'
      );
      expect(formatter.limitLiftedForUserText()).toBe(
        '✅ Админ снял для тебя ограничение на публикацию постов на текущие сутки. Можешь отправить этот пост еще раз.'
      );
    });

    it('строит уведомления о дубликатах пользователю', () => {
      expect(formatter.duplicateScheduledToUserText('01.05.26 в ~10:00')).toBe(
        'Похожий пост уже запланирован к публикации 01.05.26 в ~10:00.\nТы можешь предложить что-нибудь другое'
      );
      expect(formatter.duplicateScheduledSoonToUserText()).toBe(
        'Похожий пост уже запланирован к публикации. Ты можешь предложить что-нибудь другое'
      );
      expect(formatter.publishedDuplicateToUserText()).toBe(
        'Этот пост уже публиковался, ты можешь предложить что-нибудь другое'
      );
    });
  });

  describe('модерация и публикация', () => {
    it('строит тексты отклонения, восстановления и бана', () => {
      expect(formatter.rejectedPostText()).toBe(
        'Мы не можем такое опубликовать, твой пост отклонен'
      );
      expect(formatter.restoredAfterRejectText()).toContain('Мы передумали! 🤯');
      expect(formatter.restoredAfterRejectText()).toContain(
        'P.S. Тебе придет отдельное сообщение, когда пост будет опубликован 😉'
      );
      expect(formatter.bannedUserText()).toContain(
        'Бот больше не будет реагировать на сообщения'
      );
    });

    it('строит обратную связь после публикации', () => {
      expect(formatter.postPublishedText()).toBe('Твой пост опубликован \nПрисылай еще!\n');
      expect(formatter.postPublishedNightCringeText('<a>cringe</a>')).toBe(
        'Твой пост опубликован \nУтром пост будет перемещен в канал <a>cringe</a>'
      );
    });

    it('строит обратную связь после планирования', () => {
      expect(formatter.postScheduledText('01.05.26 в ~10:00')).toBe(
        'Твой пост будет опубликован 01.05.26 в ~10:00 ⏱\n\nПрисылай еще 😉️'
      );
      expect(formatter.postScheduledNightCringeText('01.05.26 в ~10:00', '<a>cringe</a>')).toBe(
        'Твой пост будет опубликован 01.05.26 в ~10:00 ⏱\n\n' +
          'Пост попал в особую рубрику, которая публикуется только ночью, а утром перемещается в отдельный канал: <a>cringe</a>\n' +
          'Присылай еще 😉️'
      );
    });

    it.each([
      [1, '🎉 Поздравляем! Твой пост стал одним из лучших за сутки!'],
      [2, '🎉 Поздравляем! Твои посты стали лучшими за сутки!'],
    ])('строит поздравление для %i постов', (count, expected) => {
      expect(formatter.bestMemesText(count)).toBe(expected);
    });
  });

  describe('динамические метки', () => {
    it('строит метки кнопок и статистики', () => {
      expect(formatter.publishButtonLabel('mod')).toBe('✅ Опубликовать (mod)');
      expect(formatter.discardStatisticLabel(1, 0)).toBe('👎 1 (0)');
      expect(formatter.approvedStatisticLabel(2, 1)).toBe('👍 2 (1)');
      expect(formatter.lastPostLabel('2 дня назад')).toBe('🗓 2 дня назад');
      expect(formatter.rejectedButtonLabel('mod')).toBe('👨 Отклонен ❌ (mod)');
      expect(formatter.scheduledTimeLabel('01.05.26 в ~10:00', 'mod')).toBe(
        '⏰ 01.05.26 в ~10:00 (mod)'
      );
      expect(formatter.publishedKeyboardLabel('mod')).toBe('👨 Опубликован (mod)');
    });

    it('показывает 0 страйков при отсутствии значения', () => {
      expect(formatter.strikesLabel(3)).toBe('❗ 3');
      expect(formatter.strikesLabel(undefined)).toBe('❗ 0');
      expect(formatter.strikesLabel(null)).toBe('❗ 0');
    });
  });
});
