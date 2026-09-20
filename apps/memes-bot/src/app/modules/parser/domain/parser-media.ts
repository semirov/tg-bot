import { Api } from 'telegram';

/** Информация о медиа сообщения парсера. */
export interface MediaInfo {
  kind: 'photo' | 'video';
  uniqueId: string;
}

/** Фото/видео поста: kind и стабильный id медиа (Api.Photo.id / Document.id). */
export function extractMediaInfo(message: Api.Message | undefined | null): MediaInfo | undefined {
  if (!message) return undefined;

  const video = message.video;
  if (video?.id) {
    return { kind: 'video', uniqueId: video.id.toString() };
  }

  const photo = message.photo;
  if (photo?.id) {
    return { kind: 'photo', uniqueId: photo.id.toString() };
  }

  return undefined;
}

/** channelId («ботовый» -100...) → raw channelId MTProto. */
export function rawIdOf(chatId: number): number {
  return chatId <= -1_000_000_000_000 ? -chatId - 1_000_000_000_000 : Math.abs(chatId);
}
