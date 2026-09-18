/**
 * Минимальный набор полей пользователя, нужный для отображения имени.
 */
export interface DisplayNameSource {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Форматирует отображаемое имя пользователя.
 *
 * Если задан `username`, возвращает `@username`, иначе склеивает непустые
 * имя и фамилию через пробел.
 *
 * @param user объект с полями `username`/`firstName`/`lastName`
 * @returns `@username`, либо «Имя Фамилия», либо пустую строку
 */
export function formatUserName(user: DisplayNameSource): string {
  if (user.username) {
    return `@${user.username}`;
  }

  return [user.firstName, user.lastName].filter((item) => !!item).join(' ');
}
