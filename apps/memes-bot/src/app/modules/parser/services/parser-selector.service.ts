import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { Bot } from 'grammy';
import { CLOCK, Clock } from '../../../shared/clock';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import {
  AUTO_DELIVER_PER_CYCLE,
  BACKLOG_TTL_DAYS,
  DELIVERY_RETRY_BACKOFF_MS,
  DUMP_COOLDOWN_MINUTES,
  DUMP_PER_SOURCE_CAP,
  DUMP_SIZE,
  FORCE_PER_CYCLE_CAP,
  ObservedStatus,
  POOL_TTL_DAYS,
  QUEUE_EMERGENCY_CAP,
  RANK_WINDOW,
} from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { applyDeliveryFailure, isDeliveryBackedOff } from '../domain/parser-delivery-attempts';
import { dedupBatch } from '../domain/parser-quotas';
import { computeSourceInterest, rankScore } from '../domain/parser-source-weight';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSettingsService } from './parser-settings.service';
import { BaseConfigService } from '../../config/base-config.service';

/** День бюджета считаем по московскому времени — как объявлены cron-задачи. */
const PARSER_TIMEZONE = 'Europe/Moscow';

/**
 * Селектор предложки. Авто-выдача (`deliverDue`, каждые 20 мин) ранжирует
 * оценённый пул (`rankScore` = score × вес источника) и кладёт **лучшие**
 * карточки порциями `AUTO_DELIVER_PER_CYCLE`, уважая дневной разгон
 * (`dailyLimit`, форс-посты в него не входят) и дневной кап на источник.
 * Ручной добор «Ещё 20»/`/more` (`dumpMore`) — вне бюджета. Форс-посты
 * доставляются сразу, но тоже порциями; бэклог и пул стареют (TTL).
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
    if ((await this.countBacklog()) >= QUEUE_EMERGENCY_CAP) {
      this.logger.debug('Parser selector: бэклог на аварийном пороге, форс-выдача пропущена');
      return 0;
    }

    const config = this.settings.current;
    const now = this.clock.now();
    // Голова очереди не запирает хвост: строки, проваливавшиеся в последний час,
    // в выборку не попадают — отдаём следующие по возрасту в этом же цикле.
    const retryAfter = new Date(now.getTime() - DELIVERY_RETRY_BACKOFF_MS);
    const rows = await this.observedRepository.find({
      where: [
        { status: ObservedStatus.SCORED, forced: true, lastDeliveryFailureAt: IsNull() },
        { status: ObservedStatus.SCORED, forced: true, lastDeliveryFailureAt: LessThan(retryAfter) },
      ],
      order: { createdAt: 'ASC' },
      take: FORCE_PER_CYCLE_CAP * 5,
    });
    if (!rows.length) return 0;

    const sources = await this.loadSources(rows.map((row) => row.sourceChatId));
    const eligible = rows.filter((row) => {
      if (isDeliveryBackedOff(row, now)) return false;
      const source = sources.get(row.sourceChatId);
      if (!source || source.excluded) return false;
      if (source.err != null && source.err < config.errMin) return false;
      return true;
    });
    if (!eligible.length) return 0;

    return this.deliverRows(this.pickDiverse(eligible, FORCE_PER_CYCLE_CAP), sources, false);
  }

  /**
   * «Насыпать ещё»: отдаёт до count лучших по рангу оценённых (не форс) постов —
   * ручной добор вне дневного бюджета, со своим cooldown и без ERR-гейта.
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
        where: { status: ObservedStatus.SCORED, rejectReason: IsNull(), forced: false },
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

  /**
   * Авто-выдача: каждый select-цикл (20 мин) кладёт лучшие оценённые посты, но
   * не больше дневного разгона `dailyLimit` (когда > 0) и не больше
   * `AUTO_DELIVER_PER_CYCLE` за цикл. Форс-посты бюджет не тратят.
   */
  public async deliverDue(count = AUTO_DELIVER_PER_CYCLE): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      return await this.deliverDueInner(count);
    } finally {
      this.busy = false;
    }
  }

  /** Остаток порции авто-выдачи на текущий цикл (для логов и меню). */
  public async remainingQuota(): Promise<number> {
    const config = this.settings.current;
    return this.deliveryQuota(this.clock.now(), config.dailyLimit, AUTO_DELIVER_PER_CYCLE);
  }

  private async deliverDueInner(count: number): Promise<number> {
    // Аварийный вентиль общий с форс-выдачей: выше него не льём ни то, ни другое.
    if ((await this.countBacklog()) >= QUEUE_EMERGENCY_CAP) {
      this.logger.debug('Parser selector: бэклог на аварийном пороге, авто-выдача пропущена');
      return 0;
    }

    const config = this.settings.current;
    const now = this.clock.now();
    // Дневной разгон: сколько не-форс постов «разрешено» отдать к этому часу.
    const quota = await this.deliveryQuota(now, config.dailyLimit, AUTO_DELIVER_PER_CYCLE);
    const limit = Math.min(count, quota);
    if (limit <= 0) return 0;

    // Окно ранжирования: топ по score, вес источника домешивается в памяти.
    // `score IS NOT NULL`: в PG NULL-и сортировки впереди и вытеснили бы топ.
    const rows = await this.observedRepository.find({
      where: {
        status: ObservedStatus.SCORED,
        rejectReason: IsNull(),
        forced: false,
        score: Not(IsNull()),
      },
      order: { score: 'DESC' },
      take: RANK_WINDOW,
    });
    if (!rows.length) return 0;

    const sources = await this.loadSources(rows.map((row) => row.sourceChatId));
    const unique = this.uniqueBest(rows, sources);
    const eligible = unique.filter((row) => {
      const source = sources.get(row.sourceChatId);
      if (!source || source.excluded) return false;
      // Тот же ERR-гейт, что у форс-доставки: мусорные каналы не тащим.
      if (source.err != null && source.err < config.errMin) return false;
      return true;
    });
    const withinCaps = await this.applySourceDailyCap(eligible, config.sourceDailyCap);
    const usable = this.pickDiverse(withinCaps, limit);
    if (!usable.length) return 0;

    return this.deliverRows(usable, sources, false);
  }

  /**
   * Сколько не-форс постов можно отдать в этом цикле: линейный разгон от начала
   * суток (`allowedByNow`) минус отданное сегодня, но не больше порции.
   * `dailyLimit <= 0` = безлимит (порция всё равно ограничивает залп).
   */
  private async deliveryQuota(now: Date, dailyLimit: number, perCycleCap: number): Promise<number> {
    const limit = Number(dailyLimit) || 0;
    const start = this.startOfToday(now);
    const deliveredToday = await this.observedRepository.count({
      where: {
        // Считаем доставки (по `deliveredAt`), а не текущий статус: карточка,
        // отданная и затем отклонённая/истёкшая, остаётся в бюджете дня.
        deliveredAt: MoreThanOrEqual(start),
        // Форс-посты идут вне дневного бюджета и не должны его съедать.
        forced: false,
      },
    });
    if (limit <= 0) return perCycleCap;

    const dayMs = 86_400_000;
    const elapsed = Math.min(dayMs, Math.max(0, now.getTime() - start.getTime()));
    // ceil: иначе `dailyLimit` 1–2 не отдают ничего до конца суток.
    const allowedByNow = Math.ceil((limit * elapsed) / dayMs);
    return Math.min(perCycleCap, Math.max(0, allowedByNow - deliveredToday));
  }

  /**
   * Кап на источник за сутки: один `GROUP BY` по источникам пачки (учитывает и
   * посты, отобранные в этом же прогоне). Считаем доставки по `deliveredAt`, а не
   * текущий статус, и без форса. `sourceDailyCap <= 0` = безлимит.
   */
  private async applySourceDailyCap(
    rows: ObservedPostEntity[],
    sourceDailyCap: number
  ): Promise<ObservedPostEntity[]> {
    const cap = Number(sourceDailyCap) || 0;
    if (cap <= 0 || !rows.length) return rows;

    const sourceIds = [...new Set(rows.map((row) => row.sourceChatId))];
    const counts = await this.observedRepository
      .createQueryBuilder('o')
      .select('o.sourceChatId', 'sourceChatId')
      .addSelect('COUNT(*)', 'delivered')
      .where('o.sourceChatId IN (:...sourceIds)', { sourceIds })
      .andWhere('o.deliveredAt >= :start', { start: this.startOfToday() })
      .andWhere('o.forced = :forced', { forced: false })
      .groupBy('o.sourceChatId')
      .getRawMany<{ sourceChatId: string; delivered: string }>();

    const alreadyDelivered = new Map<string, number>();
    for (const row of counts) {
      alreadyDelivered.set(String(row.sourceChatId), Number(row.delivered) || 0);
    }

    const usedThisRun = new Map<string, number>();
    return rows.filter((row) => {
      const already = alreadyDelivered.get(row.sourceChatId) ?? 0;
      const used = usedThisRun.get(row.sourceChatId) ?? 0;
      if (already + used >= cap) return false;
      usedThisRun.set(row.sourceChatId, used + 1);
      return true;
    });
  }

  /** Начало текущих суток в Europe/Moscow (как у cron-задач), а не в TZ процесса. */
  private startOfToday(now: Date = this.clock.now()): Date {
    const zoned = utcToZonedTime(now, PARSER_TIMEZONE);
    zoned.setHours(0, 0, 0, 0);
    return zonedTimeToUtc(zoned, PARSER_TIMEZONE);
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
        // Класс сбоя решает судьбу строки: терминальный — `rejected` сразу,
        // медиа-сбой — попытка (после DELIVERY_ATTEMPT_LIMIT `rejected`),
        // сеть/флуд — возврат в пул через бэкофф без траты попытки.
        const outcome = applyDeliveryFailure(
          row,
          result.reason ?? row.rejectReason,
          this.clock.now()
        );
        if (outcome.rejected && outcome.attempts > 0) {
          this.logger.warn(
            `Parser selector: пост ${row.id} отклонён после ${outcome.attempts} попыток доставки`
          );
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
    // Лучшие первыми (rankScore = score × вес источника); свежесть — только
    // тай-брейкер, чтобы старый пост не запирал топ при равном ранге.
    return ordered.sort((a, b) => {
      const rankDiff = (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0);
      if (rankDiff !== 0) return rankDiff;
      const evalDiff = (b.evaluatedAt?.getTime() ?? 0) - (a.evaluatedAt?.getTime() ?? 0);
      if (evalDiff !== 0) return evalDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
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
