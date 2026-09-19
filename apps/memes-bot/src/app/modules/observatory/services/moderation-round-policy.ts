import { InlineKeyboard } from 'grammy';

/**
 * Голоса пользовательской модерации поста.
 */
export interface ModerationVotes {
  /** Количество голосов «за». */
  likes: number;
  /** Количество голосов «против». */
  dislikes: number;
}

/**
 * Итог раунда пользовательской модерации.
 */
export interface ModerationRoundResult {
  /** Пост одобрен (`true`) или отклонён (`false`). */
  isApproved: boolean;
  /** Текст кнопки-итога для проголосовавших пользователей. */
  userResultLabel: string;
}

/**
 * Чистая политика раунда пользовательской модерации.
 *
 * Содержит правило кворума (`лайков >= дизлайков` или нет дизлайков) и
 * построение итоговой клавиатуры. Вынесена из
 * `UserModeratedPostService.handleNextUserModeratedPost`; сервис оставляет
 * метод-делегат, который использует существующая white-box спецификация.
 */
export class ModerationRoundPolicy {
  /**
   * Принимает решение по голосам и собирает текст итоговой кнопки.
   *
   * Правило повторяет исходное: `+likes >= +dislikes || +dislikes === 0`.
   * Приведение через унарный `+` сохранено для совместимости с bigint-колонками,
   * которые TypeORM может отдавать строкой.
   *
   * @param votes голоса раунда
   * @returns решение и текст кнопки
   */
  public decide(votes: ModerationVotes): ModerationRoundResult {
    const isApproved = +votes.likes >= +votes.dislikes || +votes.dislikes === 0;
    return { isApproved, userResultLabel: this.buildUserResultLabel(isApproved, votes) };
  }

  /**
   * Собирает текст итоговой кнопки с непустыми частями счётчиков.
   *
   * @param isApproved решение раунда
   * @param votes голоса раунда
   * @returns строка вида `Пост будет опубликован 👍 3   👎 1`
   */
  public buildUserResultLabel(isApproved: boolean, votes: ModerationVotes): string {
    let text = '';
    if (votes.likes) {
      text += ` 👍 ${votes.likes}`;
    }
    if (votes.dislikes) {
      text += `   👎 ${votes.dislikes}`;
    }

    return (isApproved ? 'Пост будет опубликован' : 'Пост не будет опубликован') + text;
  }

  /**
   * Строит итоговую клавиатуру для проголосовавших пользователей.
   *
   * @param result итог раунда
   * @returns клавиатура из одной кнопки с текстом итога
   */
  public buildUserResultKeyboard(result: ModerationRoundResult): InlineKeyboard {
    return new InlineKeyboard().text(result.userResultLabel);
  }
}
