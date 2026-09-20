import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { Bot } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import * as imghash from 'imghash';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';
import { DeduplicationService } from '../../bot/services/deduplication.service';
import { channelInternalId, buildPostUrl, escapeHtml } from '../../../shared/publication/telegram-link';
import { CLOCK, Clock } from '../../../shared/clock';
import { CANDIDATE_CB_PREFIX, CARD_CB_PREFIX, MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, ObservedStatus } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserClientService } from './parser-client.service';
import { ParserRegistryService } from './parser-registry.service';
import { rawIdOf } from '../domain/parser-media';
import { formatViews } from '../domain/parser-scoring';

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
  public async deliver(candidate: ObservedPostEntity): Promise<{ ok: boolean; status: ObservedStatus }> {
    const source = await this.registry.repository.findOne({ where: { chatId: candidate.sourceChatId } });
    if (!source) {
      return this.fail(candidate, 'source-missing');
    }

    const mtproto = await this.fetchMessageBytes(candidate, source);
    if (!mtproto) {
      return this.fail(candidate, 'media-fetch-failed');
    }

    if (mtproto.error) {
      return this.fail(candidate, mtproto.error);
    }

    let imageHash: string | null = null;
    if (mtproto.photoBuffer) {
      try {
        imageHash = await imghash.hash(mtproto.photoBuffer, 16);
      } catch (error) {
        this.logger.warn(`Parser delivery: imghash failed: ${error}`);
      }
      if (imageHash) {
        const duplicates = await this.deduplication.checkDuplicate(imageHash);
        const isDuplicate = (duplicates ?? []).some((item) => item.distance >= 0.5);
        if (isDuplicate) {
          candidate.status = ObservedStatus.DUPLICATE;
          candidate.rejectReason = 'published-duplicate';
          await this.observedRepository.save(candidate);
          this.logger.debug(`Parser delivery: дубликат опубликованного (${candidate.id})`);
          return { ok: false, status: ObservedStatus.DUPLICATE };
        }
      }
    }

    const messageId = await this.sendCard(candidate, source, mtproto);
    if (!messageId) {
      return this.fail(candidate, 'send-failed');
    }

    candidate.status = ObservedStatus.DELIVERED;
    candidate.deliveredAt = this.clock.now();
    candidate.requestChannelMessageId = messageId;
    candidate.imageHash = imageHash;
    await this.observedRepository.save(candidate);

    source.selectedTotal += 1;
    await this.registry.repository.save(source);

    this.logger.log(
      `Parser delivery: кандидат ${candidate.id} → предложка (msg=${messageId}, score=${candidate.score?.toFixed(2)})`
    );
    return { ok: true, status: ObservedStatus.DELIVERED };
  }

  /** Скачивает медиа через юзербот (read-only). */
  private async fetchMessageBytes(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity
  ): Promise<{ photoBuffer?: Buffer; videoBuffer?: Buffer; error?: string } | null> {
    const client = await this.activeClient();
    if (!client) return null;

    const rawId = source.rawChatId ? bigInt(source.rawChatId) : bigInt(rawIdOf(Number(source.chatId)));
    const ids = [candidate.sourceMessageId];
    const messages = await this.guard.run<TotalList<Api.Message>>('getMessages:deliver', () =>
      client.getMessages(rawId, { ids })
    );
    const message = messages?.find((m) => m?.id === candidate.sourceMessageId);
    if (!message) return null;

    const kind = candidate.mediaKind === 'video' || message.video ? 'video' : 'photo';
    const buffer = await this.guard.run('downloadMedia', () => client.downloadMedia(message));
    if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) {
      return { error: 'media-download-empty' };
    }

    if (kind === 'photo' && buffer.length > MAX_PHOTO_BYTES) {
      return { error: 'media-too-large' };
    }
    if (kind === 'video' && buffer.length > MAX_VIDEO_BYTES) {
      return { error: 'media-too-large' };
    }

    return kind === 'video' ? { videoBuffer: buffer } : { photoBuffer: buffer };
  }

  /** Карточка «Парсер» в предложке с клавиатурой модерации. */
  private async sendCard(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity,
    media: { photoBuffer?: Buffer; videoBuffer?: Buffer }
  ): Promise<number | null> {
    const caption = this.buildCaption(candidate, source);
    const keyboard = this.buildKeyboard(candidate.id);

    try {
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
    } catch (error) {
      this.logger.error(`Parser delivery: не удалось отправить карточку: ${error}`);
      return null;
    }
  }

  /** Подпись карточки: категория, источник, метрики отбора. */
  public buildCaption(candidate: ObservedPostEntity, source: SourceChannelEntity): string {
    const isCringe = source.category === 'cringe';
    const label = isCringe ? '🧭 Парсер · кринж' : '🧭 Парсер';
    const sourceLink = this.buildSourceLink(source);

    const views = candidate.views != null ? ` · 👁 ${formatViews(Number(candidate.views))}` : '';
    const reactions = candidate.reactions != null ? ` · 🔥 ${candidate.reactions}` : '';
    const score = candidate.score != null ? ` · ⭐ ${candidate.score.toFixed(1)}` : '';

    return `${label}${sourceLink ? ` · ${sourceLink}` : ''}${views}${reactions}${score}`;
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
      .text('▶️ Сейчас', `${CARD_CB_PREFIX}:now:${candidateId}`)
      .text('📋 В очередь', `${CARD_CB_PREFIX}:q:${candidateId}`)
      .row()
      .text('🌙 В ночь (кринж)', `${CARD_CB_PREFIX}:night:${candidateId}`)
      .text('🗑 Отклонить', `${CARD_CB_PREFIX}:rej:${candidateId}`);
  }

  /** Клавиатура кандидата в админ-очереди discovery. */
  public buildCandidateKeyboard(candidateId: number): InlineKeyboard {
    return new InlineKeyboard()
      .text('🌐 Web-only', `${CANDIDATE_CB_PREFIX}:wo:${candidateId}`)
      .text('➕ Джойнить', `${CANDIDATE_CB_PREFIX}:jo:${candidateId}`)
      .text('❌ Отклонить', `${CANDIDATE_CB_PREFIX}:rj:${candidateId}`);
  }

  private async fail(
    candidate: ObservedPostEntity,
    reason: string
  ): Promise<{ ok: boolean; status: ObservedStatus }> {
    candidate.status = ObservedStatus.FAILED;
    candidate.rejectReason = reason;
    await this.observedRepository.save(candidate);
    this.logger.warn(`Parser delivery: кандидат ${candidate.id} не доставлен (${reason})`);
    return { ok: false, status: ObservedStatus.FAILED };
  }

  private async activeClient(): Promise<TelegramClient | undefined> {
    return this.parserClient.client();
  }
}
