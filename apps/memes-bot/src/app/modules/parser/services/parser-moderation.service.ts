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
import { ObservedStatus, CARD_CB_PREFIX } from '../constants/parser.constants';

/** Действия карточки парсера в предложке. */
export type CardAction = 'now' | 'q' | 'night' | 'rej' | 'excl' | 'exclok' | 'exclno';
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
    this.bot.callbackQuery(
      new RegExp(`^${CARD_CB_PREFIX}:(now|q|night|rej|excl|exclok|exclno):(\\d+)$`),
      async (ctx) => {
        const action = ctx.match?.[1] as CardAction;
        const postId = Number(ctx.match?.[2]);
        await this.handleAction(ctx, action, postId);
      }
    );

  }

  public async handleAction(
    ctx: BotContext,
    action: CardAction,
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

    // Исключение источника — подтверждение и выполнение (источник меняется).
    if (action === 'excl') {
      const permission = this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL);
      if (!permission) {
        await ctx.answerCallbackQuery('Нет прав');
        return;
      }
      await ctx.answerCallbackQuery('Исключить источник?');
      await this.replaceKeyboard(ctx, this.delivery.buildExcludeConfirmKeyboard(candidate.id));
      return;
    }

    if (action === 'exclno') {
      await ctx.answerCallbackQuery('Отменено');
      await this.replaceKeyboard(ctx, this.delivery.buildKeyboard(candidate.id));
      return;
    }

    if (action === 'exclok') {
      const permission = this.userService.checkPermission(ctx, UserPermissionEnum.ALLOW_PUBLISH_TO_CHANNEL);
      if (!permission) {
        await ctx.answerCallbackQuery('Нет прав');
        return;
      }
      await this.excludeSourceOf(ctx, candidate);
      return;
    }

    // Карточка обрабатывается один раз: повторный клик по уже изменённой — отказ.
    if (candidate.status !== ObservedStatus.DELIVERED) {
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

      await this.rememberPublishedHash(candidate, published.message_id);
      await this.registry.markSourceTaken(candidate.sourceChatId);

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
    // «В сетке» = опубликовано: хеш уходит в дедуп, повторно не предложим.
    await this.rememberPublishedHash(candidate, Number(candidate.requestChannelMessageId));
    await this.registry.markSourceTaken(candidate.sourceChatId);

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
    await this.rememberPublishedHash(candidate, Number(candidate.requestChannelMessageId));
    await this.registry.markSourceTaken(candidate.sourceChatId);

    const date = PostSchedulerService.formatToMsk(publishDate);
    const formatted = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')} ~${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    await this.replaceKeyboard(
      ctx,
      new InlineKeyboard().text(`🌙 Ночь: ${formatted}`, `${CARD_CB_PREFIX}:done:${candidate.id}`)
    );
    await ctx.answerCallbackQuery('В ночной кринж');
  }

  /** Исключение источника карточки в чёрный список (с подтверждением). */
  public async excludeSourceOf(ctx: BotContext, candidate: ObservedPostEntity): Promise<void> {
    const source = await this.registry.repository.findOne({ where: { chatId: candidate.sourceChatId } });
    if (!source) {
      await ctx.answerCallbackQuery('Источник не найден');
      return;
    }
    await this.registry.excludeSource(source.id);
    await this.replaceKeyboard(
      ctx,
      new InlineKeyboard().text('🚫 Источник исключён', `${CARD_CB_PREFIX}:done:${candidate.id}`)
    );
    await ctx.answerCallbackQuery('Источник исключён');
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
    await this.registry.markSourceIgnored(candidate.sourceChatId);

    const username = ctx.callbackQuery?.from?.username ?? 'moderator';
    await this.replaceKeyboard(
      ctx,
      new InlineKeyboard().text(`🗑 Отклонено (@${escapeHtml(username)})`, `${CARD_CB_PREFIX}:done:${candidate.id}`)
    );
    await ctx.answerCallbackQuery('Отклонено');
  }

  /** Запоминает хеш как опубликованный (фото 16-бит, видео — по обложке). */
  private async rememberPublishedHash(candidate: ObservedPostEntity, messageId: number): Promise<void> {
    const hash = candidate.imageHash ?? candidate.perceptualHash;
    if (hash) await this.deduplication.createPublishedPostHash(hash, messageId);
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
