/**
 * Разбор ответа админа в канале обращений. Вынесено из сервиса в чистую
 * функцию, чтобы фильтр и обработчик одинаково определяли адресата: раньше
 * обработчик безусловно читал `ctx.channelPost.reply_to_message`, из-за чего
 * падал на обычном `message`-апдейте.
 */
export interface ReplyContextLike {
  channelPost?: {
    message_id: number;
    reply_to_message?: { message_id: number };
  } | null;
  message?: {
    message_id: number;
    reply_to_message?: { message_id: number };
  } | null;
  chat?: { id: number } | null;
}

export interface AdminReply {
  /** id сообщения-заявки, на которое ответил админ. */
  replyToMessageId: number;
  /** id сообщения-ответа админа (его и пересылаем пользователю). */
  adminMessageId: number;
  /** id чата, в котором находится ответ. */
  chatId: number;
}

/**
 * Возвращает данные ответа админа или null, если апдейт не является ответом
 * в канале обращений. Проверка чата обязательна: `message_id` уникален только
 * внутри чата, поэтому ответ в стороннем чате с совпавшим id — ложное срабатывание.
 */
export function resolveAdminReply(
  ctx: ReplyContextLike,
  requestChannelId: number
): AdminReply | null {
  const replyToMessage = ctx.channelPost?.reply_to_message ?? ctx.message?.reply_to_message;
  const adminMessageId = ctx.channelPost?.message_id ?? ctx.message?.message_id;
  const chatId = ctx.chat?.id;

  if (!replyToMessage || adminMessageId === undefined || chatId === undefined) {
    return null;
  }

  if (chatId !== requestChannelId) {
    return null;
  }

  return { replyToMessageId: replyToMessage.message_id, adminMessageId, chatId };
}
