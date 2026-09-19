import { Logger } from '@nestjs/common';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { NewMessageEvent } from 'telegram/events';

/**
 * Минимальное описание сущности Telegram-канала, нужное для сравнения ссылок.
 *
 * Перенесено из `ClientBaseService`: описывает либо разрешённую ссылку на
 * канал, либо внешний URL, не относящийся к Telegram.
 */
export interface ResolvedChannelEntity {
  /** Признак не-Telegram ссылки. */
  isExternal?: boolean;
  /** Исходный внешний URL. */
  url?: string;
  /** Идентификатор канала в Telegram. */
  id?: bigInt.BigInteger;
  /** Username канала без `@`. */
  username?: string;
}

/**
 * Порт над `TelegramClient`, достаточный для разрешения ссылок.
 *
 * Вынесен отдельным интерфейсом, чтобы `AdDetector` оставался чистым и
 * тестировался без настоящего MTProto-клиента.
 */
export interface TelegramEntityResolver {
  /**
   * Возвращает сущность Telegram по username/ссылке.
   *
   * @param entity username канала или иной идентификатор
   */
  getEntity(entity: unknown): Promise<unknown>;
}

/**
 * Коллабораторы, через которые `AdDetector.isAdPost` обращается к окружению.
 *
 * Отдельный порт (а не прямые приватные методы) нужен, чтобы сервис-фасад
 * сохранял white-box точки подмены: `ClientBaseService` передаёт сюда свои
 * тонкие обёртки, и `jest.spyOn` по ним продолжает влиять на детекцию.
 */
export interface AdDetectionPorts {
  /** Проверяет наличие ссылок в сообщении. */
  isPostWithLinks(event: NewMessageEvent): boolean | Promise<boolean>;
  /** Извлекает все ссылки из сообщения. */
  extractUrls(event: NewMessageEvent): string[] | Promise<string[]>;
  /** Разрешает ссылку в сущность канала. */
  resolveUrl(url: string): ResolvedChannelEntity | Promise<ResolvedChannelEntity>;
  /** Сравнивает разрешённую ссылку с текущим каналом. */
  isSameChannel(resolved: ResolvedChannelEntity, current: ResolvedChannelEntity): boolean;
  /** Возвращает сущность текущего канала по его id. */
  getCurrentChannel(chatId: bigInt.BigInteger): Promise<ResolvedChannelEntity>;
  /** Контекст для `Logger.error` (по умолчанию имя класса). */
  loggerContext?: string;
}

/**
 * Чистая детекция рекламы во входящих MTProto-сообщениях.
 *
 * Все методы детерминированы и не хранят состояние. Зависимость от
 * `TelegramClient` передана портом (`TelegramEntityResolver`) в `resolveUrl`,
 * а необратимые обращения к окружению в `isAdPost` — через {@link AdDetectionPorts}.
 * `ClientBaseService` оставляет у себя тонкие делегирующие обёртки, которые
 * использует существующая white-box спецификация (`(service as any).isAdPost`
 * и т.п.).
 */
export class AdDetector {
  /**
   * Проверяет, содержит ли сообщение медиа-контент (фото или видео).
   *
   * @param message сообщение Telegram
   * @returns `true` для фото, видео, media-photo и видео-документа
   */
  public hasMediaContent(message: Api.Message): boolean {
    return !!(
      message.photo ||
      message.video ||
      (message.media &&
        (message.media instanceof Api.MessageMediaPhoto ||
          (message.media instanceof Api.MessageMediaDocument &&
            message.media.document instanceof Api.Document &&
            message.media.document.mimeType.startsWith('video/'))))
    );
  }

  /**
   * Проверяет, есть ли в сообщении ссылка.
   *
   * @param event событие нового сообщения
   * @returns `true`, если есть caption и сущность `MessageEntityUrl`/`TextUrl`
   */
  public async isPostWithLinks(event: NewMessageEvent): Promise<boolean> {
    const caption = event?.message?.message;
    const entities = event?.message?.entities || [];

    if (!caption) {
      return false;
    }

    for (const entity of entities) {
      switch (true) {
        case entity instanceof Api.MessageEntityUrl:
        case entity instanceof Api.MessageEntityTextUrl: {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Извлекает все ссылки из сообщения.
   *
   * @param event событие нового сообщения
   * @returns список URL из сущностей `MessageEntityUrl` и `MessageEntityTextUrl`
   */
  public async extractUrls(event: NewMessageEvent): Promise<string[]> {
    const urls: string[] = [];
    const message = event.message;

    if (!message.entities) return urls;

    for (const entity of message.entities) {
      if (entity instanceof Api.MessageEntityUrl) {
        const offset = entity.offset;
        const length = entity.length;
        urls.push(message.message.substring(offset, offset + length));
      } else if (entity instanceof Api.MessageEntityTextUrl) {
        urls.push(entity.url);
      }
    }

    return urls;
  }

  /**
   * Разрешает ссылку в сущность Telegram-канала.
   *
   * Короткие ссылки `t.me/...` раскрываются в `https://...`; для Telegram-ссылок
   * используется `getEntity`, остальные считаются внешними.
   *
   * @param url ссылка из сообщения
   * @param client порт MTProto-клиента для `getEntity`
   * @returns сущность канала или пометка внешнего URL
   */
  public async resolveUrl(
    url: string,
    client: TelegramEntityResolver
  ): Promise<ResolvedChannelEntity> {
    // Telegram может возвращать сокращенные ссылки (t.me/xxx)
    // Нужно раскрыть их до полного URL
    if (url.startsWith('t.me/')) {
      url = `https://${url}`;
    }

    // Для Telegram ссылок используем getEntity
    if (url.includes('t.me/')) {
      const username = url.split('t.me/')[1].split('/')[0];
      return (await client.getEntity(username)) as ResolvedChannelEntity;
    }

    // Для других ссылок можно использовать HTTP запрос
    // (но нужно учитывать редиректы)
    // Здесь простейшая реализация - в реальном коде нужно обрабатывать редиректы
    return { isExternal: true, url };
  }

  /**
   * Сравнивает разрешённую ссылку с текущим каналом.
   *
   * @param resolvedEntity разрешённая ссылка
   * @param currentChannel текущий канал
   * @returns `true`, если это тот же канал по id или username
   */
  public isSameChannel(
    resolvedEntity: ResolvedChannelEntity,
    currentChannel: ResolvedChannelEntity
  ): boolean {
    // Если это внешний URL (не Telegram)
    if (resolvedEntity.isExternal) {
      return false;
    }

    // Сравниваем ID каналов
    if (resolvedEntity.id && currentChannel.id) {
      return resolvedEntity.id.equals(currentChannel.id);
    }

    // Сравниваем usernames каналов
    if (resolvedEntity.username && currentChannel.username) {
      return resolvedEntity.username.toLowerCase() === currentChannel.username.toLowerCase();
    }

    return false;
  }

  /**
   * Определяет, является ли сообщение рекламой (ссылка ведёт не на свой канал).
   *
   * Повторяет исходную оркестрацию `ClientBaseService.isAdPost`: сначала ссылки,
   * затем текст, затем разрешение каждой ссылки. Ошибка разрешения трактуется
   * как внешняя ссылка (реклама).
   *
   * @param event событие нового сообщения
   * @param ports коллабораторы окружения
   * @returns `true`, если сообщение считается рекламой
   */
  public async isAdPost(event: NewMessageEvent, ports: AdDetectionPorts): Promise<boolean> {
    // Проверяем наличие ссылок
    const hasLinks = await ports.isPostWithLinks(event);
    if (!hasLinks) return false;

    const message = event.message.message;
    if (!message) return false;

    // Получаем все ссылки из сообщения
    const urls = await ports.extractUrls(event);
    if (urls.length === 0) return false;

    // Получаем информацию о текущем канале
    const currentChannel = await ports.getCurrentChannel(event.chatId);

    // Проверяем каждую ссылку
    for (const url of urls) {
      try {
        const resolved = await ports.resolveUrl(url);

        // Если ссылка ведет не на текущий канал - считаем рекламой
        if (!ports.isSameChannel(resolved, currentChannel)) {
          return true;
        }
      } catch (error) {
        Logger.error(
          `Error resolving URL ${url}: ${error}`,
          ports.loggerContext ?? AdDetector.name
        );
        // Если не удалось разрешить URL, считаем что это внешняя ссылка
        return true;
      }
    }

    return false;
  }
}
