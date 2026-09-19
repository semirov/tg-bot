import { Logger } from '@nestjs/common';
import * as bigInt from 'big-integer';
import { Api } from 'telegram';
import { NewMessageEvent } from 'telegram/events';

/** Домены Telegram, ссылки с которых считаются Telegram-ссылками. */
const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

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
  /** Внутренний id канала (как в ссылке `t.me/c/<id>`). */
  internalId?: bigInt.BigInteger;
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
  /**
   * Резолвит invite-ссылку (`t.me/+hash`, `joinchat`) в чат.
   *
   * Необязателен: без него invite-ссылки считаются внешними.
   *
   * @param hash хеш приглашения
   */
  checkInvite?(hash: string): Promise<unknown>;
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

/** Нормализованная ссылка: username, приватный id канала или invite-хеш. */
type NormalizedTelegramLink =
  | { kind: 'username'; username: string }
  | { kind: 'private'; internal: string }
  | { kind: 'invite'; hash: string }
  | null;

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
   * Понимает формы `t.me/<user>[/<msg>]`, `telegram.me/...`, приватные
   * `t.me/c/<internal>[/<msg>]`, invite `t.me/+hash`/`joinchat/<hash>` (через
   * `checkInvite`), `tg://resolve?domain=...`. Остальное — внешний URL.
   *
   * @param url ссылка из сообщения
   * @param client порт MTProto-клиента для `getEntity`/`checkInvite`
   * @returns сущность канала или пометка внешнего URL
   */
  public async resolveUrl(
    url: string,
    client: TelegramEntityResolver
  ): Promise<ResolvedChannelEntity> {
    const normalized = this.normalizeTelegramLink(url);

    if (!normalized) {
      return { isExternal: true, url };
    }

    if (normalized.kind === 'invite') {
      if (client.checkInvite) {
        const chat = (await client.checkInvite(normalized.hash)) as ResolvedChannelEntity;
        if (chat) {
          return chat;
        }
      }
      return { isExternal: true, url };
    }

    if (normalized.kind === 'private') {
      return { internalId: bigInt(normalized.internal) };
    }

    return (await client.getEntity(normalized.username)) as ResolvedChannelEntity;
  }

  /**
   * Сравнивает разрешённую ссылку с текущим каналом.
   *
   * @param resolvedEntity разрешённая ссылка
   * @param currentChannel текущий канал
   * @returns `true`, если это тот же канал по internalId, id или username
   */
  public isSameChannel(
    resolvedEntity: ResolvedChannelEntity,
    currentChannel: ResolvedChannelEntity
  ): boolean {
    if (resolvedEntity.isExternal) {
      return false;
    }

    if (resolvedEntity.internalId && currentChannel.id) {
      return resolvedEntity.internalId.equals(currentChannel.id);
    }

    if (resolvedEntity.internalId && currentChannel.internalId) {
      return resolvedEntity.internalId.equals(currentChannel.internalId);
    }

    if (resolvedEntity.id && currentChannel.id) {
      return resolvedEntity.id.equals(currentChannel.id);
    }

    if (resolvedEntity.username && currentChannel.username) {
      return resolvedEntity.username.toLowerCase() === currentChannel.username.toLowerCase();
    }

    return false;
  }

  /**
   * Классифицирует пост по ссылкам: репостить или это спам, и почему.
   *
   * Правило: нет ссылок → репостим; все ссылки ведут на текущий канал →
   * репостим; есть хотя бы одна чужая/неразрешимая → спам.
   *
   * @param event событие нового сообщения
   * @param ports коллабораторы окружения
   * @returns результат политики с причинами
   */
  public async classifyPost(
    event: NewMessageEvent,
    ports: AdDetectionPorts
  ): Promise<LinkPolicyResult> {
    const links: string[] = [];

    const hasLinks = await ports.isPostWithLinks(event);
    if (!hasLinks) {
      return { isAd: false, reason: 'no-links', links, foreignLinks: [] };
    }

    const message = event?.message?.message;
    if (!message) {
      return { isAd: false, reason: 'no-text', links, foreignLinks: [] };
    }

    const urls = await ports.extractUrls(event);
    if (urls.length === 0) {
      return { isAd: false, reason: 'no-links', links, foreignLinks: [] };
    }
    links.push(...urls);

    const currentChannel = await ports.getCurrentChannel(event.chatId);
    const foreignLinks: string[] = [];

    for (const url of urls) {
      try {
        const resolved = await ports.resolveUrl(url);
        if (!ports.isSameChannel(resolved, currentChannel)) {
          foreignLinks.push(url);
        }
      } catch (error) {
        Logger.error(
          `Error resolving URL ${url}: ${error}`,
          ports.loggerContext ?? AdDetector.name
        );
        foreignLinks.push(url);
      }
    }

    if (foreignLinks.length > 0) {
      return { isAd: true, reason: 'foreign-link', links, foreignLinks };
    }

    return { isAd: false, reason: 'own-links-only', links, foreignLinks };
  }

  /**
   * Определяет, является ли сообщение рекламой (ссылка ведёт не на свой канал).
   *
   * @param event событие нового сообщения
   * @param ports коллабораторы окружения
   * @returns `true`, если сообщение считается рекламой
   */
  public async isAdPost(event: NewMessageEvent, ports: AdDetectionPorts): Promise<boolean> {
    const result = await this.classifyPost(event, ports);
    return result.isAd;
  }

  /**
   * Нормализует ссылку к одной из форм Telegram.
   *
   * @param url исходная ссылка из сообщения
   * @returns нормализованная ссылка или `null`, если это не Telegram
   */
  private normalizeTelegramLink(url: string): NormalizedTelegramLink {
    const trimmed = (url ?? '').trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('tg://')) {
      return this.normalizeTgScheme(trimmed);
    }

    const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
    const withoutQuery = withoutScheme.split(/[?#]/)[0];
    const slashIndex = withoutQuery.indexOf('/');
    const host = (slashIndex === -1 ? withoutQuery : withoutQuery.slice(0, slashIndex))
      .replace(/^www\./i, '')
      .toLowerCase();

    if (!TELEGRAM_HOSTS.has(host)) {
      return null;
    }

    const path = slashIndex === -1 ? '' : withoutQuery.slice(slashIndex + 1);
    const parts = path.split('/').filter((part) => part.length > 0);
    const [first, second] = parts;

    if (!first) {
      return null;
    }

    if (first === 'c' && second && /^\d+$/.test(second)) {
      return { kind: 'private', internal: second };
    }

    if (first.startsWith('+') && first.length > 1) {
      return { kind: 'invite', hash: first.slice(1) };
    }

    if (first === 'joinchat' && second) {
      return { kind: 'invite', hash: second };
    }

    const username = first.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (!username) {
      return null;
    }

    return { kind: 'username', username };
  }

  /**
   * Разбирает `tg://resolve?domain=...` и `tg://join?invite=...`.
   *
   * @param url ссылка со схемой `tg://`
   * @returns нормализованная ссылка или `null`
   */
  private normalizeTgScheme(url: string): NormalizedTelegramLink {
    const action = url.slice('tg://'.length).split(/[?/]/)[0].toLowerCase();

    if (action === 'resolve') {
      const domain = /[?&]domain=([^&]+)/i
        .exec(url)?.[1]
        ?.replace(/^@/, '')
        .replace(/[^A-Za-z0-9_]/g, '');
      if (domain) {
        return { kind: 'username', username: domain };
      }
    }

    if (action === 'join') {
      const invite = /[?&]invite=([^&]+)/i.exec(url)?.[1]?.replace(/^\+/, '');
      if (invite) {
        return { kind: 'invite', hash: invite };
      }
    }

    return null;
  }
}

/** Причина, по которой пост признан рекламой или разрешён к репосту. */
export type LinkPolicyReason = 'no-links' | 'no-text' | 'own-links-only' | 'foreign-link';

/** Результат политики ссылок. */
export interface LinkPolicyResult {
  /** `true`, если пост считается рекламой (не репостить). */
  isAd: boolean;
  /** Причина решения. */
  reason: LinkPolicyReason;
  /** Все найденные ссылки. */
  links: string[];
  /** Ссылки, которые не ведут на текущий канал. */
  foreignLinks: string[];
}
