import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { NewMessageEvent } from 'telegram/events';
import { metrics, sourceLabel } from '../../../shared/metrics';
import { CLOCK, Clock } from '../../../shared/clock';
import { BaseConfigService } from '../../config/base-config.service';
import {
  MAX_SWEEP_LOOKBACK_MS,
  ObservedStatus,
  SWEEP_FIRST_WINDOW_MS,
  SWEEP_GAP_MS,
  SWEEP_HISTORY_LIMIT,
  SWEEP_READ_OVERLAP_MS,
  SWEEP_SOURCES_PER_RUN,
  SWEEP_TIER_QUOTA,
} from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserClientService } from './parser-client.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { collectPostCrossLinks, normalizeChatId } from '../domain/parser-cross-links';
import { extractMediaInfo, rawIdOf } from '../domain/parser-media';
import { canonicalPeerKey } from '../domain/parser-peer-key';
import { selectSweepSlice } from '../domain/parser-rotation';

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

    await this.upsertCandidate(message, source, null, media);
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
    const peer = bigInt(chatId);
    const message = await this.fetchMessage(peer, primaryId);
    if (!message) return;
    const media = extractMediaInfo(message);
    if (!media) return;
    metrics.parser.albums.inc({ source: sourceLabel(source) });
    await this.upsertCandidate(message, source, group.ids, media);
  }

  /** Дедлайн, о котором уже предупредили (лог паузы — раз на дедлайн, не на тик). */
  private pausedLoggedFor = 0;

  /** History sweep: ротационная порция источников за окно (cron). */
  public async sweepAll(): Promise<number> {
    const client = this.parserClient.client();
    if (!client) return 0;

    const all = await this.registry.listCollectible();
    // Нечитаемые строки не занимают слоты ротации: свой канал и записи без
    // пира (`rawChatId`/`username`) не могут дать ни одного history-вызова.
    const readable = all.filter(
      (source) =>
        !this.registry.isOwnChannel(Number(source.chatId)) &&
        Boolean(source.rawChatId || source.username)
    );
    const skippedInvalid = all.length - readable.length;

    // Мёртвые пиры тоже не занимают слоты: пир в бэкоффе промахов
    // (`refresh` + resolve не помогли) отдаёт слот живому источнику.
    const eligible = readable.filter(
      (source) => !this.guard.isPeerBroken(canonicalPeerKey(source.chatId))
    );
    const skippedBroken = readable.length - eligible.length;

    // Ротация вместо прохода по всему реестру (TGB-125): 895 источников
    // «в лоб» — это ~180 history-вызовов и суточный FloodWait. Порция за тик —
    // 5 due `active` + 5 due `web_only` (квота тира), остальное — следующий тик.
    const nowMs = this.clock.now().getTime();
    const { selected, skippedInterval } = selectSweepSlice(
      eligible,
      nowMs,
      SWEEP_TIER_QUOTA,
      SWEEP_SOURCES_PER_RUN
    );

    let collected = 0;
    let albumsDeferred = 0;
    let skippedBudget = 0;
    let skippedBlocked = 0;

    for (const [index, source] of selected.entries()) {
      if (this.guard.isBlocked()) {
        this.logPausedOnce();
        skippedBlocked = selected.length - index;
        break;
      }
      // Пустой бюджет полосы: Telegram не дёргаем, остаток порции — в следующий прогон.
      if (!this.guard.hasBudget('history')) {
        skippedBudget = selected.length - index;
        break;
      }
      try {
        const result = await this.sweepSource(source, client);
        collected += result.collected;
        albumsDeferred += result.albumsDeferred;
      } catch (error) {
        await this.markSourceError(source, error);
      }
      await this.guard.pace(SWEEP_GAP_MS);
    }

    this.logger.log(
      `Parser sweep: selected=${selected.length} skippedInvalid=${skippedInvalid} skippedInterval=${skippedInterval} skippedBroken=${skippedBroken} skippedBudget=${skippedBudget} skippedBlocked=${skippedBlocked} albumsDeferred=${albumsDeferred} collected=${collected}`
    );
    return collected;
  }

  /** Лог паузы — один раз на дедлайн, а не на каждый cron-тик. */
  private logPausedOnce(): void {
    const untilMs = this.guard.blockedUntil();
    if (untilMs === null || untilMs === this.pausedLoggedFor) return;
    this.pausedLoggedFor = untilMs;
    this.logger.warn(
      `Parser sweep: MTProto на паузе до ${new Date(untilMs).toISOString()} — свип остановлен`
    );
  }

  /**
   * Свип одного источника. Возвращает собранных кандидатов и число альбомов,
   * которые не удалось перечитать из-за бюджета (их нельзя терять молча).
   */
  private async sweepSource(
    source: SourceChannelEntity,
    client: TelegramClient
  ): Promise<{ collected: number; albumsDeferred: number }> {
    // Валидность строки (пир есть, не свой канал) уже отфильтрована в `sweepAll`.
    // Для публичных каналов надёжнее username (не требует кэша диалогов),
    // для приватных — marked id из сессии.
    const peer = source.username ?? bigInt(source.chatId);
    const since = this.sweepSinceSeconds(source);

    let called = false;
    const messages = await this.guard.run<TotalList<Api.Message>>(
      'getHistory',
      () => {
        called = true;
        return client.getMessages(peer, { limit: SWEEP_HISTORY_LIMIT, offsetDate: since });
      },
      source.chatId
    );
    // Вызова не было (пауза/пустой бюджет/бэкофф пира): источник остаётся в
    // голове ротации, иначе сутки «съедались» бы без реального запроса.
    if (!called) return { collected: 0, albumsDeferred: 0 };

    // Отметка — «последняя попытка истории»: двигается и на пустой выдаче, и
    // на ошибке (иначе вечно падающий источник навсегда застрял бы в голове
    // LRU и жёг слот с токеном каждый тик). При упоре в лимит — курсор на
    // дату самого старого прочитанного поста, чтобы дочитать глубокий бэклог.
    source.lastSweepAt = this.nextSweepCursor(messages);
    await this.registry.repository.save(source);
    if (!messages || !messages.length) return { collected: 0, albumsDeferred: 0 };

    const albums = new Map<string, number[]>();
    let collected = 0;
    let albumsDeferred = 0;

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

      collected += await this.upsertCandidate(message, source, null, media);
    }

    for (const ids of albums.values()) {
      const primaryId = Math.max(...ids);
      const rawId = bigInt(source.chatId);
      const { message, called } = await this.fetchMessageCall(rawId, primaryId);
      if (!message) {
        // `called: false` — guard не пустил (пауза/пустой бюджет/бэкофф):
        // альбом не потерян, но и не добыт — считаем в логе прогона.
        if (!called) albumsDeferred += 1;
        continue;
      }
      const media = extractMediaInfo(message);
      if (!media) continue;
      metrics.parser.albums.inc({ source: sourceLabel(source) });
      collected += await this.upsertCandidate(message, source, ids, media);
      await this.guard.pace(400);
    }

    return { collected, albumsDeferred };
  }

  /**
   * Курсор следующего свипа: при упоре в `SWEEP_HISTORY_LIMIT` — дата самого
   * старого прочитанного поста (дочитываем с места остановки), иначе `now`
   * (выдача пустая/неполная — окно закрыто). `undefined` — вызов был, но упал.
   */
  private nextSweepCursor(messages: TotalList<Api.Message> | undefined): Date {
    const now = this.clock.now();
    if (!messages || messages.length !== SWEEP_HISTORY_LIMIT) return now;
    const dates = messages
      .map((message) => Number(message?.date ?? 0))
      .filter((date) => date > 0)
      .map((date) => date * 1000);
    if (!dates.length) return now;
    const oldest = Math.min(...dates);
    return new Date(Math.min(oldest, now.getTime()));
  }

  /**
   * Начало окна истории (сек, offsetDate): покрывает паузу между свипами
   * источника. Первый свип — `SWEEP_FIRST_WINDOW_MS` (26 ч), дальше — с
   * `lastSweepAt` минус час перекрытия, но не глубже `MAX_SWEEP_LOOKBACK_MS`:
   * у `web_only` каденс ~3–4 суток, и фиксированные 26 ч теряли историю.
   */
  private sweepSinceSeconds(source: SourceChannelEntity): number {
    const nowMs = this.clock.now().getTime();
    const lastMs = source.lastSweepAt ? new Date(source.lastSweepAt).getTime() : null;
    const sinceMs =
      lastMs === null || Number.isNaN(lastMs)
        ? nowMs - SWEEP_FIRST_WINDOW_MS
        : Math.max(lastMs - SWEEP_READ_OVERLAP_MS, nowMs - MAX_SWEEP_LOOKBACK_MS);
    return Math.floor(sinceMs / 1000);
  }

  /** Идемпотентная запись кандидата + выгрузка кросс-ссылок в discovery. */
  private async upsertCandidate(
    message: Api.Message,
    source: SourceChannelEntity,
    groupIds: number[] | null,
    media: { kind: 'photo' | 'video'; uniqueId: string }
  ): Promise<number> {
    const sourceChatId = source.chatId;
    const sourceMessageId = message.id;
    const exists = await this.observedRepository.findOne({
      where: { sourceChatId, sourceMessageId },
    });
    if (exists) {
      metrics.parser.skipped.inc({ source: sourceLabel(source), reason: 'exists' });
      return 0;
    }

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
    // Первичные цифры из истории: сразу строят базлайн канала, не дожидаясь
    // переоценки (live-посты обычно приходят с views≈0).
    if (message.views != null) {
      candidate.views = Number(message.views);
    }
    candidate.reactions = this.reactionsTotal(message);

    await this.observedRepository.save(candidate);
    metrics.parser.collected.inc({ source: sourceLabel(source), kind: media.kind });

    if (crossLinks.length) {
      await this.discovery.registerCrossLinks(crossLinks);
    }

    this.logger.debug(`Parser collector: кандидат ${sourceChatId}/${sourceMessageId} (${media.kind})`);
    return 1;
  }

  /** Сумма реакций сообщения (0, если реакций нет). */
  private reactionsTotal(message: Api.Message): number {
    const results = message.reactions?.results ?? [];
    return results.reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  }

  /**
   * Перечитывание сообщения по id. `called: false` — guard не пустил вызов
   * (пауза/пустой бюджет/бэкофф пира), `called: true` — вызов был (в т.ч.
   * неуспешный): разница нужна свипу, чтобы не терять альбомы молча.
   */
  private async fetchMessageCall(
    rawChatId: bigInt.BigInteger,
    messageId: number
  ): Promise<{ message?: Api.Message; called: boolean }> {
    const client = this.parserClient.client();
    if (!client) return { called: false };
    let called = false;
    const result = await this.guard.run<TotalList<Api.Message>>(
      'getMessages:ids',
      () => {
        called = true;
        return client.getMessages(rawChatId, { ids: [messageId] });
      },
      canonicalPeerKey(rawChatId.toString())
    );
    return { message: result?.find((m) => m?.id === messageId), called };
  }

  private async fetchMessage(rawChatId: bigInt.BigInteger, messageId: number): Promise<Api.Message | undefined> {
    return (await this.fetchMessageCall(rawChatId, messageId)).message;
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
