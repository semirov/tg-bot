/**
 * Общий помощник отправки поста с файлом в Mattermost.
 *
 * Вынесено из дублировавшихся `UserPostManagementService.sendToMattermost` и
 * `ObservatoryService.sendToMattermost`; отличается только префиксом имени
 * файла.
 */

/**
 * Минимальный контракт сервиса Mattermost, необходимый помощнику.
 */
export interface MattermostPostSenderInterface {
  /**
   * Отправляет пост, опционально прикрепляя файл.
   *
   * @param params сообщение, ссылка на файл и имя файла
   */
  sendPostWithFile(params: {
    message: string;
    fileUrl?: string;
    fileName?: string;
  }): Promise<void>;
}

/**
 * Минимальный контракт логгера.
 */
export interface ErrorLoggerInterface {
  /**
   * Логирует ошибку.
   *
   * @param message текст сообщения
   * @param optionalParams дополнительные параметры
   */
  error(message: unknown, ...optionalParams: unknown[]): void;
}

/**
 * Параметры отправки поста с файлом в Mattermost.
 */
export interface SendPostToMattermostParamsInterface {
  /** Сервис Mattermost. */
  mattermostService: MattermostPostSenderInterface;
  /** Функция получения ссылки на файл по ID сообщения в буферном канале. */
  getFileUrl: (messageId: number) => Promise<string | undefined>;
  /** Логгер ошибок отправки. */
  logger: ErrorLoggerInterface;
  /** ID сообщения в буферном канале. */
  requestChannelMessageId: number;
  /** Подпись к посту. */
  caption: string;
  /** Префикс имени файла (`meme_` или `observatory_meme_`). */
  fileNamePrefix: string;
}

/**
 * Отправляет пост с файлом в Mattermost, не прерывая основной поток публикации.
 *
 * Ошибки получения ссылки и отправки логируются, но не пробрасываются —
 * поведение исходных приватных методов.
 *
 * @param params параметры отправки
 */
export async function sendPostToMattermost(
  params: SendPostToMattermostParamsInterface
): Promise<void> {
  try {
    const fileUrl = await params.getFileUrl(params.requestChannelMessageId);
    await params.mattermostService.sendPostWithFile({
      message: params.caption,
      fileUrl,
      fileName: `${params.fileNamePrefix}${params.requestChannelMessageId}`,
    });
  } catch (error) {
    params.logger.error('Failed to send to Mattermost:', error);
  }
}
