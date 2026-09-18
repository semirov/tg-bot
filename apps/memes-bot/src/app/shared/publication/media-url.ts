/**
 * Утилиты для работы с медиафайлами Telegram.
 *
 * Вынесено из дублировавшихся приватных методов
 * `UserPostManagementService.getTelegramFileUrl` и
 * `ObservatoryService.getTelegramFileUrl`.
 */

/**
 * Минимальное описание медиа-сообщения Telegram, достаточное для извлечения
 * идентификатора файла.
 */
export interface TelegramMediaMessageInterface {
  /** Массив размеров фотографии; используется последний (самый крупный). */
  photo?: Array<{ file_id: string }>;
  /** Видео. */
  video?: { file_id: string };
  /** Документ. */
  document?: { file_id: string };
  /** Анимация (GIF). */
  animation?: { file_id: string };
}

/**
 * Извлекает `file_id` вложения из медиа-сообщения Telegram.
 *
 * Порядок проверок повторяет исходную реализацию: фото → видео → документ →
 * анимация. Для фотографии берётся последний элемент массива размеров
 * (наибольшее разрешение). Если медиа нет — возвращается `undefined`.
 *
 * @param message сообщение Telegram с одним из полей `photo`/`video`/`document`/`animation`
 * @returns `file_id` вложения или `undefined`, если медиа отсутствует
 */
export function extractTelegramFileId(
  message: TelegramMediaMessageInterface
): string | undefined {
  if (message.photo) {
    return message.photo[message.photo.length - 1].file_id;
  }
  if (message.video) {
    return message.video.file_id;
  }
  if (message.document) {
    return message.document.file_id;
  }
  if (message.animation) {
    return message.animation.file_id;
  }
  return undefined;
}

/**
 * Строит публичную ссылку на файл Telegram.
 *
 * В тестовом окружении (`tgEnv === 'test'`) в путь добавляется сегмент `test`,
 * чтобы файлы тестового бота не пересекались с продакшеном.
 *
 * @param botToken токен бота
 * @param filePath путь к файлу, полученный из `bot.api.getFile`
 * @param tgEnv окружение Telegram (`'test'` добавляет сегмент `/test`)
 * @returns абсолютная ссылка на файл на `api.telegram.org`
 */
export function buildTelegramFileUrl(botToken: string, filePath: string, tgEnv?: string): string {
  if (tgEnv === 'test') {
    return `https://api.telegram.org/file/bot${botToken}/test/${filePath}`;
  }
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}
