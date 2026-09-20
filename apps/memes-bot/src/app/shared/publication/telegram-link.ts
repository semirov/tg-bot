/**
 * Утилиты для работы со ссылками на Telegram-каналы и посты.
 *
 * Вынесено, чтобы формула «внутреннего» id канала (`t.me/c/...`) и сборка
 * ссылок на пост не дублировались в `admin-menu.service.ts`,
 * `client/domain/ad-detector.ts` и модуле observatory.
 */

/** Минимальное описание чата Telegram, достаточное для сборки ссылки. */
export interface TelegramChatLike {
  /** Числовой id чата (для каналов обычно `-100...`). */
  id?: number | string | null;
  /** Публичный username канала без `@`. */
  username?: string | null;
}

/**
 * Источник поста обсерватории: из какого канала и какого поста он пришёл.
 */
export interface TelegramPostSource {
  /** Числовой id исходного канала. */
  chatId?: number | null;
  /** Id исходного поста в канале. */
  messageId?: number | null;
  /** Публичный username исходного канала. */
  username?: string | null;
  /** Название (title) исходного канала. */
  title?: string | null;
  /** Готовая ссылка на исходный пост/канал. */
  url?: string | null;
}

/**
 * Возвращает «внутренний» id канала для ссылки вида `t.me/c/<id>/<msg>`.
 *
 * Для Bot API id каналов имеют префикс `-100`: `-1001234567890` соответствует
 * внутреннему `1234567890`. Положительные id (MTProto) возвращаются как есть.
 * Формула повторяет `userRequestMemeChannel * -1 - 1_000_000_000_000`.
 *
 * @param chatId id чата (Bot API или MTProto), строка или число
 * @returns внутренний id канала строкой
 */
export function channelInternalId(chatId: unknown): string {
  const raw = String(chatId ?? '');
  const numeric = Number(raw);

  if (!Number.isFinite(numeric)) {
    return raw.replace(/^-?100/, '');
  }

  if (numeric < 0) {
    return String(-numeric - 1_000_000_000_000);
  }

  return String(numeric);
}

/**
 * Собирает публичную ссылку на канал или конкретный пост.
 *
 * Если у канала есть username — используется `https://t.me/<username>[/<msg>]`,
 * иначе — приватная ссылка `https://t.me/c/<internal>[/<msg>]`.
 *
 * @param chat чат исходного канала
 * @param messageId id поста (необязательно)
 * @returns ссылка или `null`, если собрать её невозможно
 */
export function buildPostUrl(chat: TelegramChatLike, messageId?: number | null): string | null {
  const username = chat?.username?.trim().replace(/^@/, '');

  if (username) {
    return messageId ? `https://t.me/${username}/${messageId}` : `https://t.me/${username}`;
  }

  if (chat?.id !== undefined && chat?.id !== null && chat?.id !== '') {
    const internal = channelInternalId(chat.id);
    return messageId ? `https://t.me/c/${internal}/${messageId}` : `https://t.me/c/${internal}`;
  }

  return null;
}

/**
 * Экранирует HTML-спецсимволы для safe-вставки в `parse_mode: 'HTML'`.
 *
 * @param value исходная строка
 * @returns строка с экранированными `&`, `<`, `>`, `"`
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
