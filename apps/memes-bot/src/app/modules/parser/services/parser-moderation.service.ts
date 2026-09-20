import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { UserPermissionEnum } from '../../bot/constants/user-permission.enum';
import { channelInternalId, escapeHtml } from '../../../shared/publication/telegram-link';
import { UserService } from '../../bot/services/user.service';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import {
  PostSchedulerService,
  ScheduledPostContextInterface,
} from '../../bot/services/post-scheduler.service';
import { CringeManagementService } from '../../bot/services/cringe-management.service';
import { DeduplicationService } from '../../bot/services/deduplication.service';
import { BaseConfigService } from '../../config/base-config.service';
import { CANDIDATE_CB_PREFIX, ObservedStatus, CARD_CB_PREFIX } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { ParserRegistryService } from './parser-registry.service';

/**
 * Кнопки карточки «Парсер» в предложке: публикация сейчас, в очередь,
 * в ночной кринж, отклонить. Клавиатуры — обычные InlineKeyboard
 * (без grammY-Menu, чтобы не ловить ошибку сериализации меню).
 */
@Injectable()
export class ParserModerationService {
  private readonly logger = new Logger(ParserModerationService.name);

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly delivery: ParserDeliveryService,
    private readonly userService: UserService,
    private readonly scheduler: PostSchedulerService,
    private readonly cringeManagement: CringeManagementService,
    private readonly deduplication: DeduplicationService,
    private readonly discovery: ParserDiscoveryService,
    private readonly config: BaseConfigService,
    private readonly registry: ParserRegistryService
  ) {}

  /** Регистрирует callback-обработчики карточек и кандидатов (один раз). */
  public registerCallbacks(): void {
    this.bot.callbackQuery(new RegExp(`^${CARD_CB_PREFIX}:(now|q|night|rej):(\\d+)$`), async (ctx) => {
      const action = ctx.match?.[1] as 'now' | 'q' | 'night' | 'rej';
      const postId = Number(ctx.match?.[2]);
      await this.handleAction(ctx, action, postId);
    });

    this.bot.callbackQuery(new RegExp(`^${CANDIDATE_CB_PREFIX}:(wo|jo|rj):(\\d+)$`), async (ctx) => {
      const action = ctx.match?.[1] as 'wo' | 'jo' | 'rj';
      const candidateId = Number(ctx.match?.[2]);
      await this.handleCandidate(ctx, action, candidateId);
    });
  }

  /** Карточка кандидата discovery: web-only / джойн / отклонить. */
  public async handleCandidate(
    ctx: BotContext,
    action: 'wo' | 'jo' | 'rj',
    candidateId: number
  ): Promise<void> {
    if (!ctx.config?.isOwner) {
      await ctx.answerCallbackQuery('Доступно только владельцу');
      return;
    }

    if (action === 'rj') {
      const rejected = await this.discovery.reject(candidateId);
      await ctx.answerCallbackQuery(rejected ? 'Отклонён' : 'Не найден');
      await this.safeEdit(ctx, '❌ Кандидат отклонён');
      return;
    }

    const approved = await this.discovery.approve(candidateId, action === 'jo' ? 'join' : 'web_only');
    if (!approved) {
      await ctx.answerCallbackQuery('Не удалось добавить (см. лог)');
      await this.safeEdit(ctx, '⚠️ Не удалось добавить кандидата');
      return;
    }

    await ctx.answerCallbackQuery(action === 'jo' ? 'Добавлен (активный)' : 'Добавлен (web-only)');
    await this.safeEdit(ctx, `✅ Источник добавлен (${action === 'jo' ? 'активный' : 'web-only'})`);
  }

  private async safeEdit(ctx: BotContext, text: string): Promise<void> {
    try {
      await ctx.editMessageText(text);
    } catch {
      // карточка могла быть удалена — не критично
    }
  }

  public async handleAction(
    ctx: BotContext,
    action: 'now' | 'q' | 'night' | 'rej',
    postId: number
  ): Promise<void> {
    const candidate = await this.observedRepository.findOne({ where: { id: postId } });
    if (!candidate || candidate.requestChannelMessageId == null) {
      await ctx.answerCallbackQuery('Кандидат не найден');
      return;
    }

    const cardMessageId = ctx.callbackQuery?.message?.message_id;
    if (cardMessageId !== Number(candidate.requestChannelMessageId)) {
      await ctx.answerCallbackQuery('Пост устарел');
      return;
    }

    // Карточка обрабатывается один раз: повторный клик по уже изменённой — отказ.
    const actionable =
      action === 'rej'
        ? candidate.status === ObservedStatus.DELIVERED
        : candidate.status === ObservedStatus.DELIVERED;
    if (!actionable) {
      await ctx.answerCallbackQuery('Уже обработано');
      return;
    }

    const permission =
      action === 'rej' ? UserPermissionEnum.IS_BASE_MODERATOR : UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL;
    if (!this.userService.checkPermission(ctx, permission)) {
      await ctx.answerCallbackQuery('Нет прав');
      return;
    }

    if (action === 'now') {
      await this.publishNow(ctx, candidate);
      return;
    }
    if (action === 'q') {
      await this.queue(ctx, candidate, PublicationModesEnum.NEXT_INTERVAL, '📋');
      return;
    }
    if (action === 'night') {
      await this.publishNight(ctx, candidate);
      return;
    }
    await this.reject(ctx, candidate);
  }

  /** Публикация сейчас: копия в основной канал + ссылка на источник. */
  public async publishNow(ctx: BotContext, candidate: ObservedPostEntity): Promise<void> {
    try {
      const published = await this.bot.api.copyMessage(
        this.config.memeChanelId,
        this.config.userRequestMemeChannel,
        Number(candidate.requestChannelMessageId),
        {
          caption: this.publishCaption(candidate),
          parse_mode: 'HTML',
          disable_notification: true,
        }
      );

      candidate.status = ObservedStatus.PUBLISHED;
      candidate.publishedMessageId = published.message_id;
      await this.observedRepository.save(candidate);

      if (candidate.imageHash) {
        await this.deduplication.createPublishedPostHash(candidate.imageHash, published.message_id);
      }

      await this.replaceKeyboard(
        ctx,
        new InlineKeyboard().text('✅ Опубликовано', `${CARD_CB_PREFIX}:done:${candidate.id}`)
      );
      await ctx.answerCallbackQuery('Опубликовано');
    } catch (error) {
      this.logger.error(`Parser moderation: publish now failed: ${error}`);
      await ctx.answerCallbackQuery('Ошибка публикации');
    }
  }

  /** Постановка в расписание (общая очередь или ночной кринж). */
  public async queue(
    ctx: BotContext,
    candidate: ObservedPostEntity,
    mode: PublicationModesEnum,
    icon: string
  ): Promise<void> {
    const context: ScheduledPostContextInterface = {
      mode,
      requestChannelMessageId: Number(candidate.requestChannelMessageId),
      processedByModerator: ctx.callbackQuery?.from?.id ?? this.config.ownerId,
      isUserPost: false,
      hash: candidate.imageHash ?? '',
    };

    const publishDate = await this.scheduler.addPostToSchedule(context);
    if (!publishDate) {
      await ctx.answerCallbackQuery('Уже запланирован');
      return;
    }

    candidate.status = ObservedStatus.QUEUED;
    await this.observedRepository.save(candidate);

    const date = PostSchedulerService.formatToMsk(publishDate);
    const formatted = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')} ~${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    await this.replaceKeyboard(
      ctx,
      new InlineKeyboard().text(`${icon} Запланировано на ${formatted}`, `${CARD_CB_PREFIX}:done:${candidate.id}`)
    );
    await ctx.answerCallbackQuery('Запланировано');
  }

  /** Ночной кринж: NIGHT_CRINGE-слот + запись для переноса в cringe-канал. */
  public async publishNight(ctx: BotContext, candidate: ObservedPostEntity): Promise<void> {
    const context: ScheduledPostContextInterface = {
      mode: PublicationModesEnum.NIGHT_CRINGE,
      requestChannelMessageId: Number(candidate.requestChannelMessageId),
      processedByModerator: ctx.callbackQuery?.from?.id ?? this.config.ownerId,
      isUserPost: false,
      hash: candidate.imageHash ?? '',
    };

    const publishDate = await this.scheduler.addPostToSchedule(context);
    if (!publishDate) {
      await ctx.answerCallbackQuery('Уже запланирован');
      return;
    }

    await this.cringeManagement.repository.insert({
      requestChannelMessageId: Number(candidate.requestChannelMessageId),
      isUserPost: false,
    });

    candidate.status = ObservedStatus.QUEUED;
    await this.observedRepository.save(candidate);

    const date = PostSchedulerService.formatToMsk(publishDate);
    const formatted = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')} ~${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    await this.replaceKeyboard(
      ctx,
      new InlineKeyboard().text(`🌙 Ночь: ${formatted}`, `${CARD_CB_PREFIX}:done:${candidate.id}`)
    );
    await ctx.answerCallbackQuery('В ночной кринж');
  }

  /** Отклонение карточки модератором. */
  public async reject(ctx: BotContext, candidate: ObservedPostEntity): Promise<void> {
    candidate.status = ObservedStatus.REJECTED;
    candidate.rejectReason = 'moderator-rejected';
    await this.observedRepository.save(candidate);

    const source = await this.registry.repository.findOne({
      where: { chatId: candidate.sourceChatId },
    });
    if (source) {
      source.rejectedTotal += 1;
      await this.registry.repository.save(source);
    }

    const username = ctx.callbackQuery?.from?.username ?? 'moderator';
    await this.replaceKeyboard(
      ctx,
      new InlineKeyboard().text(`🗑 Отклонено (@${escapeHtml(username)})`, `${CARD_CB_PREFIX}:done:${candidate.id}`)
    );
    await ctx.answerCallbackQuery('Отклонено');
  }

  /** Подпись публикуемого поста: только ссылка на источник (политика TGB-21). */
  private publishCaption(candidate: ObservedPostEntity): string {
    if (!candidate.sourceChatId) return '';
    const internal = channelInternalId(Number(candidate.sourceChatId));
    return internal ? `<a href="https://t.me/c/${internal}">источник</a>` : '';
  }

  private async replaceKeyboard(ctx: BotContext, keyboard: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    } catch (error) {
      this.logger.warn(`Parser moderation: edit keyboard failed: ${error}`);
    }
  }
}
