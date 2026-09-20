import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { NewMessageEvent } from 'telegram/events';
import { CLOCK, Clock } from '../../../shared/clock';
import { BaseConfigService } from '../../config/base-config.service';
import { ObservedStatus } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserClientService } from './parser-client.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { collectPostCrossLinks, normalizeChatId } from '../domain/parser-cross-links';
import { extractMediaInfo, rawIdOf } from '../domain/parser-media';

interface AlbumGroup {
  timer: NodeJS.Timeout;
  ids: number[];
  rawChatId: string;
  kind: 'photo' | 'video';
}

/** Коллектор: live-события + history sweep по реестру источников. */
@Injectable()
export class ParserCollectorService {
  private readonly logger = new Logger(ParserCollectorService.name);

  /** Дебаунс альбомов: groupedId → {timer, ids, kind}. */
  private albumGroups = new Map<
    string,
    { timer: NodeJS.Timeout; ids: number[]; rawChatId: string; kind: 'photo' | 'video' }
  >();

  constructor(
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly registry: ParserRegistryService,
    private readonly guard: ParserMtprotoGuard,
    private readonly parserClient: ParserClientService,
    private readonly discovery: ParserDiscoveryService,
    private readonly config: BaseConfigService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Live-обработчик нового сообщения из канала (регистрируется в ParserService). */
  public async onLiveEvent(event: NewMessageEvent): Promise<void> {
    if (!event.isChannel || !event.chatId) return;

    const chatId = normalizeChatId(Number(event.chatId.toString()));
    if (this.registry.isOwnChannel(chatId)) return;

    const message = event.message;
    const media = extractMediaInfo(message);
    if (!media) return;

    const source = await this.sourceBy(chatId);
    if (!source || source.status === 'disabled') return;

    if (message.groupedId) {
      this.enqueueAlbum(message, String(chatId), media.kind);
      return;
    }

    await this.upsertCandidate(message, String(chatId), null, media);
  }

  /** Дебаунс альбома: копим id элементов группы, затем создаём кандидата. */
  private enqueueAlbum(message: Api.Message, chatId: string, kind: 'photo' | 'video'): void {
    const messageId = message.id;
    const rawChatId =
      message.peerId instanceof Api.PeerChannel
        ? String(Number(message.peerId.channelId.toString()))
        : chatId;
    const key = `${rawChatId}:${message.groupedId?.toString() ?? ''}`;

    const group = this.albumGroups.get(key);
    if (group) {
      clearTimeout(group.timer);
      if (!group.ids.includes(messageId)) group.ids.push(messageId);
      group.timer = setTimeout(() => {
        this.albumGroups.delete(key);
        void this.flushAlbum(group).catch((error) =>
          this.logger.warn(`Parser collector: ошибка обработки альбома: ${error}`)
        );
      }, 1500);
      return;
    }

    const created: AlbumGroup = {
      ids: [messageId],
      rawChatId,
      kind,
      timer: undefined as never,
    };
    created.timer = setTimeout(() => {
      this.albumGroups.delete(key);
      void this.flushAlbum(created).catch((error) =>
        this.logger.warn(`Parser collector: ошибка обработки альбома: ${error}`)
      );
    }, 1500);
    this.albumGroups.set(key, created);
  }

  private async flushAlbum(group: AlbumGroup): Promise<void> {
    if (!group.ids.length) return;
    const chatId = normalizeChatId(Number(group.rawChatId));
    if (this.registry.isOwnChannel(chatId)) return;
    const source = await this.sourceBy(chatId);
    if (!source || source.status === 'disabled') return;

    const primaryId = Math.max(...group.ids);
    const rawChatId = bigInt(group.rawChatId);
    const message = await this.fetchMessage(rawChatId, primaryId);
    if (!message) return;
    const media = extractMediaInfo(message);
    if (!media) return;
    await this.upsertCandidate(message, String(chatId), group.ids, media);
  }

  /** History sweep: добираем посты за окно по каждому источнику (cron). */
  public async sweepAll(): Promise<number> {
    const client = this.parserClient.client();
    if (!client) return 0;

    const sources = await this.registry.listCollectible();
    let collected = 0;

    for (const source of sources) {
      try {
        collected += await this.sweepSource(source, client);
      } catch (error) {
        await this.markSourceError(source, error);
      }
      await this.guard.pace(1500);
    }

    if (collected > 0) this.logger.log(`Parser sweep: собрано кандидатов ${collected}`);
    return collected;
  }

  private async sweepSource(source: SourceChannelEntity, client: TelegramClient): Promise<number> {
    if (!source.rawChatId && !source.username) {
      this.logger.warn(`Parser sweep: у источника ${source.chatId} нет rawChatId и username — пропуск`);
      return 0;
    }
    const peer = source.rawChatId ? bigInt(source.rawChatId) : source.username;
    const since = Math.floor((this.clock.now().getTime() - 26 * 3_600_000) / 1000);

    const messages = await this.guard.run<TotalList<Api.Message>>('getHistory', () =>
      client.getMessages(peer, { limit: 50, offsetDate: since })
    );
    if (!messages || !messages.length) return 0;

    source.lastSweepAt = this.clock.now();
    await this.registry.repository.save(source);

    const albums = new Map<string, number[]>();
    let collected = 0;

    for (const message of messages) {
      if (!message) continue;
      const media = extractMediaInfo(message);
      if (!media) continue;

      if (message.groupedId) {
        const key = message.groupedId.toString();
        const ids = albums.get(key) ?? [];
        ids.push(message.id);
        albums.set(key, ids);
        continue;
      }

      collected += await this.upsertCandidate(message, source.chatId, null, media);
    }

    for (const ids of albums.values()) {
      const primaryId = Math.max(...ids);
      const rawId = source.rawChatId ? bigInt(source.rawChatId) : bigInt(rawIdOf(Number(source.chatId)));
      const message = await this.fetchMessage(rawId, primaryId);
      if (!message) continue;
      const media = extractMediaInfo(message);
      if (!media) continue;
      collected += await this.upsertCandidate(message, source.chatId, ids, media);
      await this.guard.pace(400);
    }

    return collected;
  }

  /** Идемпотентная запись кандидата + выгрузка кросс-ссылок в discovery. */
  private async upsertCandidate(
    message: Api.Message,
    sourceChatId: string,
    groupIds: number[] | null,
    media: { kind: 'photo' | 'video'; uniqueId: string }
  ): Promise<number> {
    const sourceMessageId = message.id;
    const exists = await this.observedRepository.findOne({
      where: { sourceChatId, sourceMessageId },
    });
    if (exists) return 0;

    const crossLinks = collectPostCrossLinks(message, [this.config.memeChanelId, this.config.userRequestMemeChannel, this.config.cringeMemeChannelId, this.config.bestMemeChanelId, Number(sourceChatId)]);
    const fwdChatId = crossLinks.find((hit) => hit.origin === 'fwd')?.chatId ?? null;

    const candidate = this.observedRepository.create({
      sourceChatId,
      sourceMessageId,
      rawChatId: String(rawIdOf(Number(sourceChatId))),
      groupIds: groupIds && groupIds.length > 1 ? groupIds : null,
      mediaUniqueId: media.uniqueId,
      mediaKind: media.kind,
      caption: message.message ?? null,
      fwdFromChatId: fwdChatId != null ? String(fwdChatId) : null,
      crossLinks: crossLinks.length ? crossLinks.map((hit) => ({ username: hit.username, chatId: hit.chatId })) : null,
      status: ObservedStatus.PENDING,
    });
    await this.observedRepository.save(candidate);

    if (crossLinks.length) {
      await this.discovery.registerCrossLinks(crossLinks);
    }

    this.logger.debug(`Parser collector: кандидат ${sourceChatId}/${sourceMessageId} (${media.kind})`);
    return 1;
  }

  private async fetchMessage(rawChatId: bigInt.BigInteger, messageId: number): Promise<Api.Message | undefined> {
    const client = this.parserClient.client();
    if (!client) return undefined;
    const result = await this.guard.run<TotalList<Api.Message>>('getMessages:ids', () =>
      client.getMessages(rawChatId, { ids: [messageId] })
    );
    return result?.find((m) => m?.id === messageId);
  }

  private async sourceBy(chatId: number): Promise<SourceChannelEntity | null> {
    return this.registry.repository.findOne({ where: { chatId: String(chatId) } });
  }

  private async markSourceError(source: SourceChannelEntity, error: unknown): Promise<void> {
    source.lastErrorAt = this.clock.now();
    source.lastError = String((error as Error)?.message ?? error).slice(0, 500);
    await this.registry.repository.save(source);
    this.logger.warn(`Parser sweep: источник ${source.title ?? source.chatId} ошибка: ${source.lastError}`);
  }
}
