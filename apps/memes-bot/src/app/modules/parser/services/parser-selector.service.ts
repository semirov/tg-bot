import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, IsNull, Not, Repository } from 'typeorm';
import { Bot } from 'grammy';
import { CLOCK, Clock } from '../../../shared/clock';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import {
  BACKLOG_TTL_DAYS,
  DUMP_COOLDOWN_MINUTES,
  DUMP_PER_SOURCE_CAP,
  DUMP_SIZE,
  ObservedStatus,
  POOL_TTL_DAYS,
} from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { dedupBatch } from '../domain/parser-quotas';
import { computeSourceInterest, rankScore } from '../domain/parser-source-weight';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSettingsService } from './parser-settings.service';
import { BaseConfigService } from '../../config/base-config.service';

/**
 * Селектор «по требованию»: в предложку ничего не льётся само. Посты выдаются
 * пачкой (до DUMP_SIZE) по кнопке «Ещё 20» на последней карточке или команде
 * /more. Форс-посты (разошлись по 3+ каналам) доставляются сразу.
 * Бэклог стареет: карточки старше BACKLOG_TTL_DAYS удаляются, пул — POOL_TTL_DAYS.
 */
@Injectable()
export class ParserSelectorService {
  private readonly logger = new Logger(ParserSelectorService.name);
  private busy = false;
  private lastDumpAt = 0;

  constructor(
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly registry: ParserRegistryService,
    private readonly delivery: ParserDeliveryService,
    private readonly settings: ParserSettingsService,
    private readonly config: BaseConfigService,
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Форс-посты уходят сразу и без скоринга, но чёрный список и ERR источника
   * всё равно уважаем (форс не должен тащить мусорные каналы).
   */
  public async deliverForced(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      return await this.deliverForcedInner();
    } finally {
      this.busy = false;
    }
  }

  private async deliverForcedInner(): Promise<number> {
    const config = this.settings.current;
    const rows = await this.observedRepository.find({
      where: { status: ObservedStatus.SCORED, forced: true },
      order: { createdAt: 'ASC' },
      take: DUMP_SIZE * 5,
    });
    if (!rows.length) return 0;

    const sources = await this.loadSources(rows.map((row) => row.sourceChatId));
    const eligible = rows.filter((row) => {
      const source = sources.get(row.sourceChatId);
      if (!source || source.excluded) return false;
      if (source.err != null && source.err < config.errMin) return false;
      return true;
    });
    if (!eligible.length) return 0;

    return this.deliverRows(this.pickDiverse(eligible, DUMP_SIZE), sources, false);
  }

  /**
   * «Насыпать ещё»: отдаёт до count самых свежих оценённых постов (свежие
   * первыми, вес — тай-брейкер). Пропускает excluded; cooldown игнорируется.
   */
  public async dumpMore(count = DUMP_SIZE): Promise<number> {
    if (this.busy) {
      this.logger.debug('Parser selector: добор уже идёт');
      return 0;
    }
    const now = this.clock.now();
    if (now.getTime() - this.lastDumpAt < DUMP_COOLDOWN_MINUTES * 60_000) {
      this.logger.debug('Parser selector: слишком частый добор');
      return 0;
    }

    const limit = count;

    this.busy = true;
    try {
      // Шире выборка — чтобы кап на источник реально давал разнообразие.
      const rows = await this.observedRepository.find({
        where: { status: ObservedStatus.SCORED, rejectReason: IsNull() },
        order: { createdAt: 'DESC' },
        take: Math.max(limit * 5, limit + 20),
      });
      if (!rows.length) return 0;

      const sources = await this.loadSources(rows.map((row) => row.sourceChatId));
      const unique = this.uniqueBest(rows, sources);
      const eligible = unique.filter((row) => {
        const source = sources.get(row.sourceChatId);
        return Boolean(source) && !source?.excluded;
      });
      const usable = this.pickDiverse(eligible, limit);
      if (!usable.length) return 0;

      const delivered = await this.deliverRows(usable, sources, true);
      if (delivered) this.lastDumpAt = this.clock.now().getTime();
      return delivered;
    } finally {
      this.busy = false;
    }
  }

  /** Старение бэклога: карточки 7д и оценённый пул 14д истекают. */
  public async ageBacklog(): Promise<number> {
    const now = this.clock.now();
    const backlogThreshold = new Date(now.getTime() - BACKLOG_TTL_DAYS * 86_400_000);
    const poolThreshold = new Date(now.getTime() - POOL_TTL_DAYS * 86_400_000);

    const staleCards = await this.observedRepository.find({
      where: { status: ObservedStatus.DELIVERED, deliveredAt: LessThan(backlogThreshold) },
      take: 200,
    });
    for (const card of staleCards) {
      await this.deleteCardMessage(card);
      card.status = ObservedStatus.EXPIRED;
      card.rejectReason = `backlog-${BACKLOG_TTL_DAYS}d`;
      await this.observedRepository.save(card);
      await this.registry.markSourceIgnored(card.sourceChatId, false);
    }

    const stalePool = await this.observedRepository.find({
      where: { status: ObservedStatus.SCORED, createdAt: LessThan(poolThreshold) },
      take: 200,
    });
    for (const row of stalePool) {
      row.status = ObservedStatus.EXPIRED;
      row.rejectReason = `pool-${POOL_TTL_DAYS}d`;
      await this.observedRepository.save(row);
    }

    const stuck = await this.observedRepository.find({
      where: {
        status: ObservedStatus.SELECTED,
        requestChannelMessageId: IsNull(),
        updatedAt: LessThan(new Date(now.getTime() - 3_600_000)),
      },
      take: 100,
    });
    for (const row of stuck) {
      row.status = ObservedStatus.SCORED;
      await this.observedRepository.save(row);
    }

    const expired = staleCards.length + stalePool.length;
    if (expired) this.logger.log(`Parser selector: состарилось постов ${expired}`);
    return expired;
  }

  /** Сколько карточек сейчас в предложке (для паузы оценки и меню). */
  public countBacklog(): Promise<number> {
    return this.observedRepository.count({ where: { status: ObservedStatus.DELIVERED } });
  }

  private async deliverRows(
    rows: ObservedPostEntity[],
    sources: Map<string, SourceChannelEntity>,
    withMoreButton: boolean
  ): Promise<number> {
    let delivered = 0;
    let lastDelivered: ObservedPostEntity | null = null;

    for (const row of rows) {
      const source = sources.get(row.sourceChatId);
      if (!source) {
        row.status = ObservedStatus.REJECTED;
        row.rejectReason = 'source-missing';
        await this.observedRepository.save(row);
        continue;
      }

      row.status = ObservedStatus.SELECTED;
      await this.observedRepository.save(row);

      const result = await this.delivery.deliver(row);
      if (result.ok) {
        delivered += 1;
        lastDelivered = row;
      } else if (result.status === ObservedStatus.FAILED) {
        if (TERMINAL_FAILS.has(row.rejectReason ?? '')) {
          row.status = ObservedStatus.REJECTED;
        } else {
          // Транзиентный сбой (сеть/flood) — вернуть в пул без причины.
          row.status = ObservedStatus.SCORED;
          row.rejectReason = null;
        }
        await this.observedRepository.save(row);
      }
      await this.pace(1200);
    }

    if (withMoreButton && lastDelivered?.requestChannelMessageId) {
      await this.moveMoreButton(lastDelivered);
    }
    if (delivered) this.logger.log(`Parser selector: доставлено постов ${delivered}`);
    return delivered;
  }

  /**
   * Снимает кнопку «Ещё» с прошлой последней карточки и ставит на новую.
   * Прошлую ищем в БД (не в памяти) — переживает рестарт.
   */
  private async moveMoreButton(last: ObservedPostEntity): Promise<void> {
    const recent = await this.observedRepository.find({
      where: { status: ObservedStatus.DELIVERED, requestChannelMessageId: Not(IsNull()) },
      order: { deliveredAt: 'DESC' },
      take: 5,
    });
    for (const card of recent) {
      if (card.id === last.id) continue;
      if (card.requestChannelMessageId) {
        await this.delivery.detachMoreButton(Number(card.requestChannelMessageId), card.id);
      }
      break;
    }
    if (last.requestChannelMessageId) {
      await this.delivery.attachMoreButton(Number(last.requestChannelMessageId), last.id);
    }
  }

  private uniqueBest(
    rows: ObservedPostEntity[],
    sources: Map<string, SourceChannelEntity>
  ): ObservedPostEntity[] {
    // Вес считаем один раз на пост (дорого пересчитывать в компараторе).
    const now = this.clock.now();
    const ranks = new Map(rows.map((row) => [row.id, this.rank(row, sources, now)]));
    const ids = dedupBatch(
      rows.map((row) => ({ id: row.id, score: ranks.get(row.id) ?? 0, fileKey: row.mediaUniqueId }))
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id)).filter((row): row is ObservedPostEntity => Boolean(row));
    // Свежие первыми, вес и скор — тай-брейкеры.
    return ordered.sort((a, b) => {
      const fresh = b.createdAt.getTime() - a.createdAt.getTime();
      if (fresh !== 0) return fresh;
      return (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0);
    });
  }

  private rank(
    row: ObservedPostEntity,
    sources: Map<string, SourceChannelEntity>,
    now: Date
  ): number {
    const source = sources.get(row.sourceChatId);
    if (!source) return rankScore(row.score ?? 0, undefined);
    // Вес считаем на лету: положительный буст остывает от давности последнего взятия.
    const interest = computeSourceInterest(
      {
        takenTotal: source.takenTotal ?? 0,
        ignoredTotal: source.ignoredTotal ?? 0,
        softIgnoredTotal: source.softIgnoredTotal ?? 0,
        lastIgnoredAt: source.lastIgnoredAt,
        lastTakenAt:
          source.lastTakenAt ?? ((source.takenTotal ?? 0) > 0 ? source.createdAt : null),
      },
      now
    );
    return rankScore(row.score ?? 0, interest.weight);
  }

  /**
   * Разнообразие выдачи: не больше DUMP_PER_SOURCE_CAP постов одного канала
   * за раз. Кап строгий — лучше выдать меньше, чем залить один канал.
   */
  private pickDiverse(rows: ObservedPostEntity[], limit: number): ObservedPostEntity[] {
    const picked: ObservedPostEntity[] = [];
    const perSource = new Map<string, number>();
    for (const row of rows) {
      if (picked.length >= limit) break;
      const key = row.sourceChatId;
      const used = perSource.get(key) ?? 0;
      if (used >= DUMP_PER_SOURCE_CAP) continue;
      perSource.set(key, used + 1);
      picked.push(row);
    }
    return picked;
  }

  private async loadSources(
    chatIds: ReadonlyArray<string>
  ): Promise<Map<string, SourceChannelEntity>> {
    const ids = [...new Set(chatIds)];
    const sources = await this.registry.repository.find({ where: { chatId: In(ids) } });
    return new Map(sources.map((source) => [source.chatId, source]));
  }

  private async deleteCardMessage(card: ObservedPostEntity): Promise<void> {
    if (card.requestChannelMessageId == null) return;
    try {
      await this.bot.api.deleteMessage(
        this.channelId(),
        Number(card.requestChannelMessageId)
      );
    } catch (error) {
      this.logger.warn(`Parser selector: не удалось удалить карточку ${card.id}: ${error}`);
      try {
        await this.bot.api.editMessageCaption(
          this.channelId(),
          Number(card.requestChannelMessageId),
          { caption: '🚫 Состарилось', reply_markup: { inline_keyboard: [] } }
        );
      } catch (editError) {
        this.logger.warn(`Parser selector: не удалось пометить карточку ${card.id}: ${editError}`);
      }
    }
  }

  private channelId(): number {
    return this.config.userRequestMemeChannel;
  }

  private async pace(baseMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, baseMs);
      timer.unref?.();
    });
  }
}

/** Ошибки доставки, которые не имеет смысла повторять. */
const TERMINAL_FAILS = new Set(['media-too-large', 'message-gone', 'source-missing']);
