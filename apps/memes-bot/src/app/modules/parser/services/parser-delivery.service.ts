import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { Bot } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import * as imghash from 'imghash';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';
import { DeduplicationService } from '../../bot/services/deduplication.service';
import { metrics, sourceLabel } from '../../../shared/metrics';
import { channelInternalId, buildPostUrl, escapeHtml } from '../../../shared/publication/telegram-link';
import { CLOCK, Clock } from '../../../shared/clock';
import { CARD_CB_PREFIX, MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, ObservedStatus, PUBLISHED_DUPLICATE_SIMILARITY, QUEUE_MERGE_SIMILARITY, VIDEO_MERGE_SIMILARITY } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserClientService } from './parser-client.service';
import { ParserRegistryService } from './parser-registry.service';
import { formatViews } from '../domain/parser-scoring';
import { mediaFailureReason } from '../domain/parser-delivery-attempts';

/** Итог доставки: `reason` — класс сбоя для селектора (bounded attempts). */
export interface DeliveryResult {
  ok: boolean;
  status: ObservedStatus;
  reason?: string;
}

/** Медиа поста, полученное юзерботом; `error` — причина сбоя (см. `mediaFailureReason`). */
interface MediaPayload {
  photoBuffer?: Buffer;
  videoBuffer?: Buffer;
  thumbBuffer?: Buffer;
  error?: string;
}

/**
 * Доставка отобранных кандидатов в предложку: юзербот отдаёт байты медиа,
 * бот публикует карточку «Парсер» с инлайн-клавиатурой модерации.
 */
@Injectable()
export class ParserDeliveryService {
  private readonly logger = new Logger(ParserDeliveryService.name);

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
    private readonly guard: ParserMtprotoGuard,
    private readonly registry: ParserRegistryService,
    private readonly parserClient: ParserClientService,
    private readonly deduplication: DeduplicationService,
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Полный цикл доставки одного кандидата. */
  public async deliver(candidate: ObservedPostEntity): Promise<DeliveryResult> {
    const source = await this.registry.repository.findOne({ where: { chatId: candidate.sourceChatId } });
    if (!source) {
      return this.fail(candidate, 'source-missing');
    }

    const mtproto = await this.fetchMedia(candidate, source);
    if (mtproto.error) {
      return this.fail(candidate, mtproto.error);
    }

    let imageHash: string | null = null;
    let perceptualHash: string | null = null;
    const hashSource = mtproto.photoBuffer ?? mtproto.thumbBuffer;
    if (hashSource) {
      try {
        // imghash(bits=16) в этой версии даёт hex-строку 64 символа —
        // совпадает с длиной колонки published_post_hashes.hash (varchar(64)).
        if (mtproto.photoBuffer) {
          imageHash = await imghash.hash(mtproto.photoBuffer, 16);
        }
        // Фото хешируем напрямую, видео — по обложке (первому кадру).
        perceptualHash = await imghash.hash(hashSource, 16);
      } catch (error) {
        this.logger.warn(`Parser delivery: imghash failed: ${error}`);
      }
    }
    // «В сетке» и опубликованное считаются опубликованными: фото — по 16-бит
    // хешу, видео — по обложке (64-бит). Такие посты больше не предлагаются.
    // Порог PUBLISHED_DUPLICATE_SIMILARITY (0.85), а не 0.5: случайная пара
    // картинок даёт ~0.48 совпадения битов, мемы с однотонным фоном — легко
    // >0.5, при 0.5 дедуп браковал почти весь поток.
    const publishedHash = imageHash ?? perceptualHash;
    if (publishedHash) {
      const duplicates = await this.deduplication.checkDuplicateSameLength(publishedHash);
      const best = (duplicates ?? []).reduce(
        (max, item) => Math.max(max, item.distance ?? 0),
        0
      );
      if (best >= PUBLISHED_DUPLICATE_SIMILARITY) {
        candidate.status = ObservedStatus.DUPLICATE;
        candidate.rejectReason = 'published-duplicate';
        await this.observedRepository.save(candidate);
        metrics.parser.deliveryFailures.inc({ reason: 'published-duplicate' });
        this.logger.warn(
          `Parser delivery: кандидат ${candidate.id} — дубликат опубликованного ` +
            `(similarity ${best.toFixed(3)})`
        );
        return { ok: false, status: ObservedStatus.DUPLICATE };
      }
    }
    // Тот же мем уже лежит карточкой в предложке (из другого канала) — склеиваем.
    if (perceptualHash) {
      const merged = await this.tryMergeIntoQueue(candidate, source, perceptualHash);
      if (merged) return merged;
    }

    const messageId = await this.sendCard(candidate, source, mtproto);
    if (!messageId) {
      return this.fail(candidate, 'send-failed');
    }

    candidate.status = ObservedStatus.DELIVERED;
    candidate.deliveredAt = this.clock.now();
    candidate.requestChannelMessageId = messageId;
    candidate.imageHash = imageHash;
    candidate.perceptualHash = perceptualHash;
    // Успех закрывает историю сбоев: строка ушла из пула, счётчик не копится.
    candidate.deliveryAttempts = 0;
    await this.observedRepository.save(candidate);

    source.selectedTotal += 1;
    await this.registry.repository.save(source);
    metrics.parser.delivered.inc({ source: sourceLabel(source), category: source.category });

    this.logger.log(
      `Parser delivery: кандидат ${candidate.id} → предложка (msg=${messageId}, score=${candidate.score?.toFixed(2)})`
    );
    return { ok: true, status: ObservedStatus.DELIVERED };
  }

  /**
   * В предложке уже есть необработанная карточка с тем же мемом (по 64-битному
   * перцептивному хешу)? Тогда старую карточку удаляем, а новый (нижний) пост
   * встаёт на её место, показывая первый источник и «+N» остальных.
   * Запланированные/опубликованные карточки сюда не попадают — они уже
   * засчитаны как опубликованные (published-duplicate).
   */
  private async tryMergeIntoQueue(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity,
    perceptualHash: string
  ): Promise<{ ok: boolean; status: ObservedStatus } | null> {
    const recent = await this.observedRepository.find({
      where: { status: ObservedStatus.DELIVERED, perceptualHash: Not(IsNull()) },
      order: { deliveredAt: 'DESC' },
      take: 200,
    });

    const threshold =
      candidate.mediaKind === 'video' ? VIDEO_MERGE_SIMILARITY : QUEUE_MERGE_SIMILARITY;
    let best: ObservedPostEntity | null = null;
    let bestDistance = 0;
    for (const row of recent) {
      if (row.id === candidate.id || !row.perceptualHash) continue;
      const distance = this.deduplication.calculateHashDistance(perceptualHash, row.perceptualHash);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }
    if (!best || bestDistance < threshold) return null;

    await this.supersedeCard(best, candidate, source);
    return null;
  }

  /** Источники карточки в порядке появления: первый (корневой), затем остальные. */
  private async cardSources(
    card: ObservedPostEntity
  ): Promise<Array<{ chatId: string; title: string | null; username: string | null }>> {
    const rootChatId = card.rootSourceChatId ?? card.sourceChatId;
    let title = card.rootSourceTitle;
    let username = card.rootSourceUsername;
    if (!card.rootSourceChatId) {
      const own = await this.registry.repository.findOne({ where: { chatId: card.sourceChatId } });
      title = own?.title ?? null;
      username = own?.username ?? null;
    }
    const sources = [{ chatId: rootChatId, title, username }];
    for (const extra of card.extraSources ?? []) {
      if (!sources.some((item) => item.chatId === extra.chatId)) sources.push(extra);
    }
    return sources;
  }

  /**
   * Вытеснение старой карточки: удаляем её сообщение, а новый кандидат
   * получает список источников (первый — самый ранний) и станет нижним постом.
   */
  private async supersedeCard(
    old: ObservedPostEntity,
    candidate: ObservedPostEntity,
    source: SourceChannelEntity
  ): Promise<void> {
    const previous = await this.cardSources(old);
    const merged = [...previous];
    if (!merged.some((item) => item.chatId === String(source.chatId))) {
      merged.push({ chatId: String(source.chatId), title: source.title ?? null, username: source.username ?? null });
    }

    candidate.rootSourceChatId = merged[0].chatId;
    candidate.rootSourceTitle = merged[0].title;
    candidate.rootSourceUsername = merged[0].username;
    candidate.extraSources = merged.slice(1);
    await this.observedRepository.save(candidate);

    old.status = ObservedStatus.DUPLICATE;
    old.rejectReason = `superseded-by-${candidate.id}`;
    old.duplicateOfId = candidate.id;
    await this.observedRepository.save(old);
    await this.deleteCardMessage(old);

    this.logger.log(
      `Parser delivery: карточка ${old.id} вытеснена кандидатом ${candidate.id} (источников: ${merged.length})`
    );
  }

  /** Удаляет сообщение карточки; если нельзя — помечает его как дубль. */
  private async deleteCardMessage(card: ObservedPostEntity): Promise<void> {
    if (card.requestChannelMessageId == null) return;
    try {
      await this.bot.api.deleteMessage(this.config.userRequestMemeChannel, Number(card.requestChannelMessageId));
    } catch (error) {
      this.logger.warn(`Parser delivery: не удалось удалить карточку ${card.id}: ${error}`);
      try {
        await this.bot.api.editMessageCaption(
          this.config.userRequestMemeChannel,
          Number(card.requestChannelMessageId),
          { caption: '🚫 Дубль — актуальная карточка ниже', reply_markup: { inline_keyboard: [] } }
        );
      } catch (editError) {
        this.logger.warn(`Parser delivery: не удалось пометить карточку ${card.id}: ${editError}`);
      }
    }
  }

  /**
   * Медиа кандидата через юзербот (read-only). Битый `file_reference`
   * (`FILE_REFERENCE_EXPIRED`) даёт `media-fetch-failed`: перечитываем сообщение
   * ОДИН раз — `getMessages` отдаёт свежую ссылку — и повторяем скачивание.
   * Попытку доставки селектор считает уже после этого повтора. Пока MTProto на
   * флуд-паузе, повторного вызова нет (и попытка не тратится).
   */
  private async fetchMedia(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity
  ): Promise<MediaPayload> {
    const first = await this.readMedia(candidate, source);
    if (first.error !== 'media-fetch-failed') return first;
    if (this.guard.isBlocked()) return { error: 'mtproto-blocked' };
    return this.readMedia(candidate, source);
  }

  /** Одно чтение сообщения и скачивание медиа; сбои — классами доставки. */
  private async readMedia(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity
  ): Promise<MediaPayload> {
    const client = await this.activeClient();
    if (!client) return { error: 'no-client' };
    if (this.guard.isBlocked()) return { error: 'mtproto-blocked' };

    // Для публичных каналов надёжнее username (без кэша диалогов).
    const peer = source.username ?? bigInt(source.chatId);
    const ids = [candidate.sourceMessageId];
    const read = await this.guarded(
      'getMessages:deliver',
      () => client.getMessages(peer, { ids }),
      source.chatId
    );
    if (read.error) return { error: read.error };
    const message = read.value?.find((m) => m?.id === candidate.sourceMessageId);
    if (!message) return { error: 'media-fetch-failed' };

    const kind = candidate.mediaKind === 'video' || message.video ? 'video' : 'photo';
    const download = await this.guarded('downloadMedia', () => client.downloadMedia(message));
    if (download.error) return { error: download.error };
    const buffer = download.value;
    if (!(buffer instanceof Buffer) || buffer.length === 0) {
      return { error: 'media-download-empty' };
    }

    if (kind === 'photo' && buffer.length > MAX_PHOTO_BYTES) {
      return { error: 'media-too-large' };
    }
    if (kind === 'video' && buffer.length > MAX_VIDEO_BYTES) {
      return { error: 'media-too-large' };
    }

    if (kind === 'video') {
      // Обложка видео (первый кадр) — перцептивный отпечаток для склейки.
      const thumbBuffer = await this.downloadThumb(message);
      return thumbBuffer ? { videoBuffer: buffer, thumbBuffer } : { videoBuffer: buffer };
    }
    return { photoBuffer: buffer };
  }

  /**
   * MTProto-вызов через guard с сохранением сырой ошибки: guard гасит сбой в
   * `undefined`, а класс сбоя (сеть/флуд/медиа) нужен, чтобы не тратить попытку
   * доставки и не приговаривать здоровый пост.
   */
  private async guarded<T>(
    operation: string,
    fn: () => Promise<T>,
    entity?: string | number
  ): Promise<{ value?: T; error?: string }> {
    let called = false;
    let failed: unknown = null;
    const value = await this.guard.run<T>(
      operation,
      async () => {
        called = true;
        try {
          return await fn();
        } catch (error) {
          failed = error;
          throw error;
        }
      },
      entity
    );
    // fn не вызывался — guard на паузе/в бэкоффе пира: вызова не было, попытку не тратим.
    if (!called) return { error: 'mtproto-blocked' };
    if (failed != null) return { error: mediaFailureReason(failed) };
    return { value };
  }

  /** Скачивает обложку видео (крупнейший размер), если она есть. */
  private async downloadThumb(message: Api.Message): Promise<Buffer | null> {
    const thumbs = message.video?.thumbs ?? [];
    const thumb = thumbs.length ? thumbs[thumbs.length - 1] : undefined;
    if (!thumb) return null;
    const client = await this.activeClient();
    if (!client) return null;
    const buffer = await this.guard.run('downloadThumb', () =>
      client.downloadMedia(message, { thumb: thumb as never })
    );
    return buffer instanceof Buffer && buffer.length > 0 ? buffer : null;
  }

  /** Карточка «Парсер» в предложке с клавиатурой модерации. */
  private async sendCard(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity,
    media: { photoBuffer?: Buffer; videoBuffer?: Buffer }
  ): Promise<number | null> {
    const caption = this.buildCaption(candidate, source);
    const keyboard = this.buildKeyboard(candidate.id);

    const send = async (): Promise<number | null> => {
      if (media.videoBuffer) {
        const sent = await this.bot.api.sendVideo(
          this.config.userRequestMemeChannel,
          new InputFile(media.videoBuffer, `parser_${candidate.id}.mp4`),
          {
            caption,
            parse_mode: 'HTML',
            disable_notification: true,
            reply_markup: keyboard,
          }
        );
        return sent.message_id;
      }
      if (media.photoBuffer) {
        const sent = await this.bot.api.sendPhoto(
          this.config.userRequestMemeChannel,
          new InputFile(media.photoBuffer, `parser_${candidate.id}.jpg`),
          {
            caption,
            parse_mode: 'HTML',
            disable_notification: true,
            reply_markup: keyboard,
          }
        );
        return sent.message_id;
      }
      return null;
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        const retryAfter = this.retryAfterSeconds(error);
        if (retryAfter > 0 && attempt < 2) {
          this.logger.warn(`Parser delivery: flood-wait ${retryAfter}s, повтор`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, (retryAfter + 1) * 1000);
            timer.unref?.();
          });
          continue;
        }
        this.logger.error(`Parser delivery: не удалось отправить карточку: ${error}`);
        return null;
      }
    }
    return null;
  }

  /** retry_after из ошибки Bot API (429), иначе 0. */
  private retryAfterSeconds(error: unknown): number {
    const e = error as { error?: { error_code?: number; parameters?: { retry_after?: number } }; parameters?: { retry_after?: number } };
    if (e?.error?.error_code === 429 || e?.parameters?.retry_after) {
      return Number(e.error?.parameters?.retry_after ?? e.parameters?.retry_after ?? 1);
    }
    return 0;
  }

  /** Подпись карточки: категория, источник, метрики отбора. */
  public buildCaption(candidate: ObservedPostEntity, source: SourceChannelEntity): string {
    const isCringe = source.category === 'cringe';
    const label = isCringe ? '🧭 Парсер · кринж' : '🧭 Парсер';
    const sourceLink = this.buildSourceLink(source);

    const views = candidate.views != null ? ` · 👁 ${formatViews(Number(candidate.views))}` : '';
    const reactions = candidate.reactions != null ? ` · 🔥 ${candidate.reactions}` : '';
    const score = candidate.score != null ? ` · ⭐ ${candidate.score.toFixed(1)}` : '';

    // Первым показываем самый ранний (корневой) источник, далее счётчик «+N».
    const mainLink = candidate.rootSourceChatId
      ? this.buildExtraSourceLink({
          chatId: candidate.rootSourceChatId,
          title: candidate.rootSourceTitle,
          username: candidate.rootSourceUsername,
        })
      : sourceLink;
    const extraCount = (candidate.extraSources ?? []).length;
    const extra = extraCount > 0 ? ` · +${extraCount}` : '';
    const forced = candidate.forced ? ' · ⚡️ форс' : '';

    return `${label}${mainLink ? ` · ${mainLink}` : ''}${extra}${forced}${views}${reactions}${score}`;
  }

  /** Ссылка на дополнительный источник склеенной карточки. */
  public buildExtraSourceLink(item: {
    chatId: string;
    title: string | null;
    username: string | null;
  }): string {
    const name = escapeHtml(item.title ?? item.username ?? 'источник');
    if (item.username) return `<a href="https://t.me/${item.username}">${name}</a>`;
    const chatId = Number(item.chatId);
    if (!item.chatId || !Number.isFinite(chatId) || chatId === 0) return name;
    const url = buildPostUrl({ id: chatId, username: undefined }, null);
    if (url) return `<a href="${url}">${name}</a>`;
    const internal = channelInternalId(chatId);
    return internal ? `<a href="https://t.me/c/${internal}">${name}</a>` : name;
  }

  /** Ссылка на канал-источник (username или внутренняя форма). */
  public buildSourceLink(source: SourceChannelEntity): string {
    const chatId = Number(source.chatId);
    const url = buildPostUrl({ id: chatId, username: source.username ?? undefined }, null);
    const name = escapeHtml(source.title ?? source.username ?? 'источник');
    if (url) return `<a href="${url}">${name}</a>`;
    const internal = channelInternalId(chatId);
    return internal ? `<a href="https://t.me/c/${internal}">${name}</a>` : name;
  }

  /** Инлайн-клавиатура карточки (обычный InlineKeyboard — без граммY-Menu). */
  public buildKeyboard(candidateId: number): InlineKeyboard {
    return new InlineKeyboard()
      .text('▶️ Сейчас', `${CARD_CB_PREFIX}:now:${candidateId}`).success()
      .text('📋 В очередь', `${CARD_CB_PREFIX}:q:${candidateId}`).primary()
      .row()
      .text('🌙 В ночь (кринж)', `${CARD_CB_PREFIX}:night:${candidateId}`).primary()
      .text('🗑 Отклонить', `${CARD_CB_PREFIX}:rej:${candidateId}`).danger()
      .row()
      .text('🚫 Исключить источник', `${CARD_CB_PREFIX}:excl:${candidateId}`).danger();
  }

  /** Добавляет к карточке кнопку «Ещё 20» (на последней карточке бэклога). */
  public async attachMoreButton(messageId: number, candidateId: number): Promise<void> {
    const keyboard = this.buildKeyboard(candidateId)
      .row()
      .text('🍲 Ещё 20', `${CARD_CB_PREFIX}:more:${candidateId}`);
    await this.editKeyboard(messageId, keyboard);
  }

  /** Убирает кнопку «Ещё 20» с карточки (она перестала быть последней). */
  public async detachMoreButton(messageId: number, candidateId: number): Promise<void> {
    await this.editKeyboard(messageId, this.buildKeyboard(candidateId));
  }

  private async editKeyboard(messageId: number, keyboard: InlineKeyboard): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(this.config.userRequestMemeChannel, messageId, {
        reply_markup: keyboard,
      });
    } catch (error) {
      const text = String(error);
      if (text.includes('message is not modified')) {
        this.logger.debug(`Parser delivery: клавиатура ${messageId} без изменений`);
        return;
      }
      this.logger.warn(`Parser delivery: не удалось обновить клавиатуру ${messageId}: ${error}`);
    }
  }

  /** Клавиатура подтверждения снятия с публикации. */
  public buildUnscheduleConfirmKeyboard(candidateId: number): InlineKeyboard {
    return new InlineKeyboard()
      .text('✅ Снять с публикации', `${CARD_CB_PREFIX}:unschedok:${candidateId}`).danger()
      .text('↩️ Отмена', `${CARD_CB_PREFIX}:unschedno:${candidateId}`);
  }

  /** Клавиатура подтверждения исключения источника. */
  public buildExcludeConfirmKeyboard(candidateId: number): InlineKeyboard {
    return new InlineKeyboard()
      .text('✅ Да, исключить', `${CARD_CB_PREFIX}:exclok:${candidateId}`).danger()
      .text('↩️ Отмена', `${CARD_CB_PREFIX}:exclno:${candidateId}`);
  }

  private async fail(candidate: ObservedPostEntity, reason: string): Promise<DeliveryResult> {
    candidate.status = ObservedStatus.FAILED;
    candidate.rejectReason = reason;
    await this.observedRepository.save(candidate);
    metrics.parser.deliveryFailures.inc({ reason });
    this.logger.warn(`Parser delivery: кандидат ${candidate.id} не доставлен (${reason})`);
    return { ok: false, status: ObservedStatus.FAILED, reason };
  }

  private async activeClient(): Promise<TelegramClient | undefined> {
    return this.parserClient.client();
  }
}
