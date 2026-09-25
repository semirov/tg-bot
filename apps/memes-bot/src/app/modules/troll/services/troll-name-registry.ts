import { sanitizeUserInput } from '../utils/troll-sanitizer';

/**
 * Очищает имя автора для контекста: одна строка, без делимитеров и переводов
 * строк.
 *
 * Вынесено из `TrollService.cleanName`, чтобы одним и тем же правилом
 * пользовались и реестр имён, и форматтер ответов.
 *
 * @param name исходное отображаемое имя
 * @returns очищенное имя или `null`, если после очистки ничего не осталось
 */
export function cleanName(name?: string | null): string | null {
  if (!name) {
    return null;
  }
  const cleaned = sanitizeUserInput(name, 64).replace(/\n+/g, ' ').trim();
  return cleaned || null;
}

/**
 * Извлекает чистое имя человека из отображаемого имени Telegram.
 *
 * Отбрасывает `@username` (в скобках и без), эмодзи и прочие не-буквенные
 * символы, берёт первое слово и приводит первую букву к верхнему регистру.
 * Возвращает `null`, если настоящего имени нет (только ник или пусто).
 *
 * @param displayName отображаемое имя вида «Имя Фамилия (@nick)»
 * @returns чистое имя с большой буквы или `null`
 */
export function extractFirstName(displayName?: string | null): string | null {
  if (!displayName) {
    return null;
  }
  const cleaned = displayName
    .replace(/\(@[^)]*\)/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return null;
  }
  const first = cleaned.split(' ')[0];
  if (!first || first.length < 2) {
    return null;
  }
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Возвращает регистр имени в тексте: находит каноническое имя (без учёта
 * регистра) и подставляет его с большой буквы. Используется там, где нет
 * полного реестра чата (например, в объявлении тега).
 *
 * @param text текст ответа модели (обычно уже в нижнем регистре)
 * @param displayName отображаемое имя участника
 * @returns текст с именем в правильном регистре
 */
export function restoreNameCase(text: string, displayName: string): string {
  const canonical = extractFirstName(displayName);
  if (!canonical || !text) {
    return text;
  }
  const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(`(^|[^a-zа-яё0-9])(${escaped})(?=[^a-zа-яё0-9]|$)`, 'gi'),
    (_match, prefix: string) => `${prefix}${canonical}`
  );
}

/**
 * Реестр имён участников по чатам и восстановление регистра в ответах модели.
 *
 * Модель получает переписку в «чатовом» стиле (всё в нижнем регистре), поэтому
 * исходный регистр имён приходится возвращать по карте, накопленной из
 * сообщений. Состояние (карта чат → пользователь → имя) живёт здесь, методы —
 * тонкие обёртки на `TrollService`.
 */
export class TrollNameRegistry {
  /** Имена участников по чатам (chatId → userId → имя) — для возврата регистра. */
  private readonly chatNames = new Map<number, Map<number, string>>();

  /**
   * Запоминает отображаемое имя участника для возврата регистра в ответах.
   *
   * @param chatId идентификатор чата
   * @param userId идентификатор пользователя (может отсутствовать)
   * @param userName отображаемое имя
   */
  public trackName(chatId: number, userId?: number | null, userName?: string | null): void {
    if (userId === undefined || userId === null || !userName) {
      return;
    }
    const perChat = this.chatNames.get(chatId) ?? new Map<number, string>();
    perChat.set(Number(userId), userName);
    this.chatNames.set(chatId, perChat);
  }

  /**
   * Очищает имя автора для контекста: одна строка, без делимитеров.
   *
   * @param name исходное имя
   * @returns очищенное имя или `null`
   */
  public cleanName(name?: string | null): string | null {
    return cleanName(name);
  }

  /**
   * Возвращает исходный регистр имён участников: `toChatStyle()` опускает всё
   * в нижний регистр, поэтому имена восстанавливаем по карте имён чата.
   *
   * @param chatId идентификатор чата
   * @param text ответ модели, в котором нужно вернуть регистр имён
   * @returns текст с восстановленным регистром имён
   */
  public restoreNames(chatId: number, text: string): string {
    const users = this.chatNames.get(chatId);
    if (!users || !text) {
      return text;
    }

    const candidates = new Set<string>();
    for (const display of users.values()) {
      const withoutUsername = display.replace(/\s*\(@[^)]*\)\s*$/, '').trim();
      if (withoutUsername) {
        candidates.add(withoutUsername);
      }
      const short = withoutUsername.split(/\s+/)[0];
      if (short && short.length >= 2) {
        candidates.add(short);
      }
      // Каноническое имя с большой буквы: даже если отображаемое имя написано
      // строчными, в ответе оно вернётся в правильном регистре.
      const canonical = extractFirstName(display);
      if (canonical) {
        candidates.add(canonical);
      }
    }

    let result = text;
    for (const name of candidates) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^a-zа-яё0-9])(${escaped})(?=[^a-zа-яё0-9]|$)`, 'gi');
      result = result.replace(re, (_match, prefix: string) => `${prefix}${name}`);
    }
    return result;
  }

  /**
   * Каноническое имя участника: первое слово отображаемого имени с большой
   * буквы. Используется для подписей в расшифровке, чтобы модель видела чистые
   * имена, а не «Имя Фамилия (@nick)».
   *
   * @param chatId идентификатор чата
   * @param userId идентификатор пользователя
   * @returns чистое имя или `null`
   */
  public firstName(chatId: number, userId?: number | null): string | null {
    if (userId === undefined || userId === null) {
      return null;
    }
    const display = this.chatNames.get(chatId)?.get(Number(userId));
    return extractFirstName(display);
  }
}
