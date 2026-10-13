import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { CLOCK, Clock } from '../../../shared/clock';
import { RANDOM, Random } from '../../../shared/random';
import { metrics } from '../../../shared/metrics';
import {
  EvalStage,
  FORCE_MIN_SOURCES,
  FORCE_WINDOW_HOURS,
  ObservedStatus,
  QUEUE_EMERGENCY_CAP,
} from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserRegistryService } from './parser-registry.service';
import { ParserClientService } from './parser-client.service';
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { ParserSettingsService } from './parser-settings.service';
import { ParserAiService } from './parser-ai.service';
import {
  ChannelBaseline,
  computePostMetrics,
  computeScore,
  countReactions,
  passesCringe,
  passesThresholds,
} from '../domain/parser-scoring';

/** Максимум id в одном `getMessages` (альбомы добавляют десятки id). */
const GET_MESSAGES_ID_CHUNK = 100;

/** Префикс причины отказа при повторной оценке пула (`re-eval:<reasons>`). */
const RE_EVAL_PREFIX = 're-eval:';

/** Исход записи вердикта: записан SCORED / REJECTED / пропущен (гонка). */
type EvaluationOutcome = 'scored' | 'rejected' | 'skipped';

/** Параметры guarded-записи вердикта (см. `applyEvaluation`). */
interface EvaluationWrite {
  /** Статус, с которым строка прочитана: пишем, только пока он держится. */
  expectedStatus: ObservedStatus;
  /** Бампать ли `selectedTotal` источника (актуализация пула — не выбор владельца). */
  bumpSelected: boolean;
  /** Метка актуализации: при заданном значении пишем `refreshedAt`/`refreshCount`. */
  refreshAt?: Date;
  /** Префикс причины отказа (`re-eval:` в актуализации пула). */
  rejectReasonPrefix?: string;
}

/**
 * Оценщик: перечитывает кандидатов через messages.getMessages, нормирует
 * просмотры/реакции по базлайну канала и выставляет скор/вердикт. Второй фазой
 * цикла актуализирует уже оценённый пул (`refreshScored`): метрики в Telegram
 * продолжают расти, поэтому старые SCORED-посты перечитываются и переоцениваются.
 */
@Injectable()
export class ParserEvaluatorService {
  private readonly logger = new Logger(ParserEvaluatorService.name);
  /** Итоги последнего `evaluateDue()` для строки лога цикла. */
  private lastEvaluateRun = { expired: 0, forced: 0 };

  constructor(
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly registry: ParserRegistryService,
    private readonly parserClient: ParserClientService,
    private readonly guard: ParserMtprotoGuard,
    private readonly settings: ParserSettingsService,
    private readonly ai: ParserAiService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM) private readonly random: Random
  ) {}

  /** Разбивка последнего прогона оценки (истекло/форс) — для лога цикла. */
  public get lastEvaluateStats(): { expired: number; forced: number } {
    return this.lastEvaluateRun;
  }

  /** Оценка кандидатов (cron): pre-оценка, финал, истечение TTL. */
  public async evaluateDue(): Promise<number> {
    this.lastEvaluateRun = { expired: 0, forced: 0 };
    const client = this.parserClient.client();
    if (!client) return 0;

    const config = this.settings.current;
    const now = this.clock.now();

    // Форс обрабатываем всегда, даже если обычная оценка на паузе.
    const forced = await this.promoteForced(now);
    this.lastEvaluateRun.forced = forced;

    // Бэклог предложки на аварийном пороге — не грузим юзербот и источники впустую.
    const backlog = await this.countBacklog();
    if (backlog >= QUEUE_EMERGENCY_CAP) {
      if (forced) {
        this.logger.log(
          `Parser evaluate: форс ${forced} (оценка на паузе, бэклог ${backlog} ≥ ${QUEUE_EMERGENCY_CAP})`
        );
      }
      return 0;
    }

    const expired = await this.expireOld(now, config.candidateTtlHours);
    this.lastEvaluateRun.expired = expired;

    const due = await this.observedRepository.find({
      where: [
        { status: ObservedStatus.PENDING },
        // PRE-кандидаты, дозревшие до финальной оценки (t+12/24ч).
        { status: ObservedStatus.SCORED, evalStage: EvalStage.PRE },
      ],
      order: { id: 'ASC' },
      take: 300,
    });

    let evaluated = 0;
    for (const candidate of due) {
      const ageMs = now.getTime() - candidate.createdAt.getTime();
      const finalDue = ageMs >= config.evalFinalHours * 3_600_000;
      const preDue = ageMs >= config.evalPreHours * 3_600_000;
      if (candidate.status === ObservedStatus.SCORED) {
        if (!finalDue) continue;
        const ok = await this.evaluateCandidate(candidate, EvalStage.FINAL, client);
        if (ok) evaluated += 1;
      } else {
        if (!preDue) continue;
        const stage = finalDue ? EvalStage.FINAL : EvalStage.PRE;
        const ok = await this.evaluateCandidate(candidate, stage, client);
        if (ok) evaluated += 1;
      }
      await this.pace(400);
    }

    if (evaluated || expired || forced) {
      this.logger.log(`Parser evaluate: оценено ${evaluated}, истекло ${expired}, форс ${forced}`);
    }
    return evaluated;
  }

  /** Оценка одного кандидата: перечитали метрики → посчитали → вердикт. */
  public async evaluateCandidate(
    candidate: ObservedPostEntity,
    stage: EvalStage,
    client: TelegramClient
  ): Promise<boolean> {
    // Статус на момент чтения: guarded-запись не должна откатить карточку,
    // которую параллельный select-цикл уже забрал (SELECTED/DELIVERED).
    const expectedStatus = candidate.status;
    const source = await this.registry.repository.findOne({
      where: { chatId: candidate.sourceChatId },
    });
    if (!source) {
      return this.reject(candidate, 'source-missing', expectedStatus);
    }

    const baseline = await this.resolveBaseline(source, client);
    if (!baseline) {
      this.logger.debug(`Parser evaluate: нет базлайна у ${source.chatId} — кандидат ждёт`);
      return false;
    }

    const ids = [candidate.sourceMessageId, ...(candidate.groupIds ?? [])];
    const messages = await this.guard.run<TotalList<Api.Message>>('getMessages:eval', () =>
      client.getMessages(bigInt(source.chatId), { ids }) // marked id
    );
    // Сетевая неудача guard'а — не «пост удалён»: пропускаем, повторим позже.
    if (messages === undefined) return false;
    const fresh = messages?.find((m) => m?.id === candidate.sourceMessageId);
    if (!fresh) {
      return this.reject(candidate, 'message-gone', expectedStatus);
    }

    const outcome = await this.applyEvaluation(candidate, source, fresh, stage, baseline, {
      expectedStatus,
      bumpSelected: true,
    });
    return outcome !== 'skipped';
  }

  /**
   * Общее ядро вердикта для первичной оценки и актуализации пула: посчитать
   * метрики по свежему сообщению, выставить скор и записать вердикт.
   *
   * Запись условная (`update ... where status = expectedStatus`): строку мог
   * одновременно забрать селектор, и тогда писать в неё нельзя — иначе поздняя
   * актуализация воскресит уже доставленную карточку.
   */
  private async applyEvaluation(
    candidate: ObservedPostEntity,
    source: SourceChannelEntity,
    message: Api.Message,
    stage: EvalStage,
    baseline: ChannelBaseline,
    write: EvaluationWrite
  ): Promise<EvaluationOutcome> {
    const views = message.views ?? 0;
    const reactions = countReactions(this.reactionResults(message));

    if (this.settings.current.aiEnabled) {
      const aiReject = await this.ai.rejectPostIfTrash(candidate.caption);
      if (aiReject) {
        const reason = `${write.rejectReasonPrefix ?? ''}${aiReject}`;
        const written = await this.reject(candidate, reason, write.expectedStatus);
        return written ? 'rejected' : 'skipped';
      }
    }

    const postMetrics = computePostMetrics(views, reactions, baseline);
    const score = computeScore(postMetrics);
    const evaluatedAt = this.clock.now();
    const patch: Partial<ObservedPostEntity> = {
      views,
      reactions: reactions.total,
      metrics: postMetrics,
      score,
      evaluatedAt,
    };

    const passed =
      source.category === 'cringe'
        ? passesCringe(views, postMetrics, this.settings.current.cringeMinViews, this.settings.current.cringeShareMin)
        : passesThresholds(views, reactions.total, postMetrics, this.thresholds(), baseline);

    if (stage === EvalStage.FINAL && !passed.passed) {
      patch.evalStage = EvalStage.FINAL;
      patch.status = ObservedStatus.REJECTED;
      patch.rejectReason = `${write.rejectReasonPrefix ?? ''}${passed.reasons.join(';')}`;
      if (!(await this.guardUpdate(candidate.id, write.expectedStatus, patch))) return 'skipped';
      await this.bumpSourceRejections(source);
      Object.assign(candidate, patch);
      return 'rejected';
    }

    patch.evalStage = stage;
    patch.status = ObservedStatus.SCORED;
    patch.rejectReason = null;
    if (write.refreshAt) {
      patch.refreshedAt = write.refreshAt;
      patch.refreshCount = candidate.refreshCount + 1;
    }

    if (!(await this.guardUpdate(candidate.id, write.expectedStatus, patch))) {
      this.logger.debug(
        `Parser evaluate: строка ${candidate.id} уже выбрана/доставлена — запись вердикта пропущена`
      );
      return 'skipped';
    }
    // Актуализация пула — не выбор владельца: счётчик взятий не бампаем.
    if (write.bumpSelected) await this.bumpSourceSelections(source);
    Object.assign(candidate, patch);
    return 'scored';
  }

  /**
   * Актуализация оценённого пула: перечитывает метрики старых SCORED-постов
   * (батчем по источнику через `getMessages`), переоценивает их и обновляет
   * пересечения. Возвращает число успешно обновлённых строк. Ход идёт вне
   * дневного бюджета доставки, но под тем же аварийным порогом бэклога.
   */
  public async refreshScored(): Promise<number> {
    const client = this.parserClient.client();
    if (!client) {
      metrics.parser.refreshed.inc({ result: 'skipped' });
      return 0;
    }

    const config = this.settings.current;
    const backlog = await this.countBacklog();
    if (backlog >= QUEUE_EMERGENCY_CAP) {
      metrics.parser.refreshed.inc({ result: 'skipped' });
      this.logger.debug(
        `Parser refresh: бэклог ${backlog} ≥ ${QUEUE_EMERGENCY_CAP}, актуализация пропущена`
      );
      return 0;
    }

    const now = this.clock.now();
    const rows = await this.refreshStaleCandidates(now, config.refreshBatchSize, config.refreshStaleHours);
    const refreshed = rows.length ? await this.refreshBatch(rows, client, now) : 0;

    // Пересечения перепроверяем тем же прогоном, но по широкому окну — посты,
    // разошедшиеся по каналам давно, тоже должны стать форсом.
    const forced = await this.promoteForced(now, config.forceRefreshWindowHours);
    if (refreshed || forced) {
      this.logger.log(`Parser refresh: обновлено ${refreshed}, форс ${forced}`);
    }
    return refreshed;
  }

  /** Старые SCORED FINAL (не форс): самые давно не читанные первыми. */
  private refreshStaleCandidates(
    now: Date,
    batch: number,
    staleHours: number
  ): Promise<ObservedPostEntity[]> {
    const threshold = new Date(now.getTime() - staleHours * 3_600_000);
    return this.observedRepository.find({
      where: {
        status: ObservedStatus.SCORED,
        evalStage: EvalStage.FINAL,
        forced: false,
        evaluatedAt: LessThan(threshold),
      },
      order: { evaluatedAt: 'ASC' },
      take: Math.max(1, batch),
    });
  }

  /** Перечитывает пачку постов, группируя ids по каналу-источнику. */
  private async refreshBatch(
    rows: ObservedPostEntity[],
    client: TelegramClient,
    now: Date
  ): Promise<number> {
    const bySource = new Map<string, ObservedPostEntity[]>();
    for (const row of rows) {
      const group = bySource.get(row.sourceChatId) ?? [];
      group.push(row);
      bySource.set(row.sourceChatId, group);
    }

    let refreshed = 0;
    for (const [chatId, sourceRows] of bySource) {
      const source = await this.registry.repository.findOne({ where: { chatId } });
      if (!source) {
        for (const row of sourceRows) {
          const written = await this.reject(row, 'source-missing', ObservedStatus.SCORED);
          metrics.parser.refreshed.inc({ result: written ? 'rejected' : 'skipped' });
        }
        continue;
      }

      const baseline = await this.resolveBaseline(source, client);
      if (!baseline) {
        // Нет базлайна — оставляем `evaluatedAt` как есть и повторим позже.
        metrics.parser.refreshed.inc({ result: 'skipped' });
        continue;
      }

      const fetched = await this.fetchRefreshMessages(sourceRows, source, client);
      // Сетевая неудача guard'а — не «пост удалён»: источник пропускаем целиком.
      if (!fetched) {
        metrics.parser.refreshed.inc({ result: 'skipped' });
        await this.pace(400);
        continue;
      }

      const write: EvaluationWrite = {
        expectedStatus: ObservedStatus.SCORED,
        bumpSelected: false,
        refreshAt: now,
        rejectReasonPrefix: RE_EVAL_PREFIX,
      };
      for (const row of sourceRows) {
        const fresh = fetched.get(row.sourceMessageId);
        if (!fresh) {
          const written = await this.reject(row, 'message-gone', ObservedStatus.SCORED);
          metrics.parser.refreshed.inc({ result: written ? 'gone' : 'skipped' });
          continue;
        }

        const outcome = await this.applyEvaluation(row, source, fresh, EvalStage.FINAL, baseline, write);
        if (outcome === 'scored') {
          refreshed += 1;
          metrics.parser.refreshed.inc({ result: 'refreshed' });
        } else {
          metrics.parser.refreshed.inc({ result: outcome === 'rejected' ? 'rejected' : 'skipped' });
        }
      }
      await this.pace(400);
    }
    return refreshed;
  }

  /**
   * Читает ids пачки одним запросом на источник, но чанками по
   * `GET_MESSAGES_ID_CHUNK` (альбомы дают десятки id). `null` — сетевой сбой
   * guard'а: источник пропускаем целиком, `evaluatedAt` не трогаем.
   */
  private async fetchRefreshMessages(
    rows: ObservedPostEntity[],
    source: SourceChannelEntity,
    client: TelegramClient
  ): Promise<Map<number, Api.Message> | null> {
    const peer = source.username ?? bigInt(source.chatId);
    const ids = rows.flatMap((row) => [row.sourceMessageId, ...(row.groupIds ?? [])]);
    const found = new Map<number, Api.Message>();

    for (let offset = 0; offset < ids.length; offset += GET_MESSAGES_ID_CHUNK) {
      const chunk = ids.slice(offset, offset + GET_MESSAGES_ID_CHUNK);
      const messages = await this.guard.run<TotalList<Api.Message>>('getMessages:refresh', () =>
        client.getMessages(peer, { ids: chunk })
      );
      if (messages === undefined) return null;
      for (const message of messages) {
        if (message) found.set(message.id, message);
      }
    }
    return found;
  }

  /** Базлайн канала: свежий сохранённый → пересчёт → история (первичный). */
  private async resolveBaseline(
    source: SourceChannelEntity,
    client: TelegramClient
  ): Promise<ChannelBaseline | null> {
    const stored = this.freshBaseline(source) ?? (await this.registry.computeBaselineFor(source));
    if (stored) return stored;
    // Круг «baseline ← оценённые посты ← baseline» разрываем первичным
    // базлайном из истории канала (getHistory, read-only).
    return this.registry.seedBaselineFromHistory(source, client);
  }

  /** Сколько карточек лежит в предложке (аварийный порог для всех фаз). */
  private countBacklog(): Promise<number> {
    return this.observedRepository.count({ where: { status: ObservedStatus.DELIVERED } });
  }

  /**
   * Готов ли кандидат к выбору селектором: финал прошёл, либо hot на pre.
   * В режиме boost (relax=true) берём любой оценённый пост без отказа.
   */
  public isEligible(candidate: ObservedPostEntity, relax = false): boolean {
    if (candidate.forced) return true;
    if (candidate.status !== ObservedStatus.SCORED) return false;
    if (candidate.rejectReason) return false;
    if (relax) return true;
    if (candidate.evalStage === EvalStage.FINAL) return true;
    return candidate.score != null && candidate.score >= this.settings.current.hotScore;
  }

  /** Свежий сохранённый базлайн (суточный stats-job) приоритетнее пересчёта. */
  private freshBaseline(source: SourceChannelEntity): ChannelBaseline | null {
    const stored = source.baseline;
    if (!stored || stored.sampleSize < 5) return null;
    const updatedAt = stored.updatedAt ? new Date(stored.updatedAt).getTime() : 0;
    if (this.clock.now().getTime() - updatedAt > 86_400_000) return null;
    return stored;
  }

  private thresholds() {
    const config = this.settings.current;
    return {
      minViews: config.minViews,
      minReactions: config.minReactions,
      nvMin: config.nvMin,
      nrMin: config.nrMin,
      posShareMin: config.posShareMin,
      hotScore: config.hotScore,
    };
  }

  private async expireOld(now: Date, ttlHours: number): Promise<number> {
    const threshold = new Date(now.getTime() - ttlHours * 3_600_000);
    const stale = await this.observedRepository.find({
      where: [
        { status: ObservedStatus.PENDING, createdAt: LessThan(threshold) },
        { status: ObservedStatus.SCORED, createdAt: LessThan(threshold) },
      ],
      take: 200,
    });
    let expired = 0;
    for (const row of stale) {
      // Guarded: строку мог одновременно забрать селектор (SELECTED/DELIVERED).
      const written = await this.guardUpdate(row.id, row.status, {
        status: ObservedStatus.EXPIRED,
        rejectReason: `ttl-${ttlHours}h`,
      });
      if (written) expired += 1;
    }
    return expired;
  }

  /**
   * Форс-посты: одно медиа в 3+ разных каналах за окно — сразу в предложку,
   * минуя пороги и ожидание pre/final. Скоринг не нужен: виральность важнее.
   * Окно параметризовано: обычная оценка смотрит узкое (`FORCE_WINDOW_HOURS`),
   * актуализация пула — широкое (`forceRefreshWindowHours`), чтобы поднять и
   * старые пересечения.
   */
  public async promoteForced(now: Date, windowHours = FORCE_WINDOW_HOURS): Promise<number> {
    const since = new Date(now.getTime() - windowHours * 3_600_000);
    const groups = await this.observedRepository
      .createQueryBuilder('o')
      .select('o.mediaUniqueId', 'media')
      .addSelect('COUNT(DISTINCT o.sourceChatId)', 'sources')
      .where('o.mediaUniqueId IS NOT NULL')
      .andWhere('o.createdAt >= :since', { since })
      .andWhere('o.status IN (:...statuses)', {
        statuses: [ObservedStatus.PENDING, ObservedStatus.SCORED],
      })
      .groupBy('o.mediaUniqueId')
      .having('COUNT(DISTINCT o.sourceChatId) >= :min', { min: FORCE_MIN_SOURCES })
      .getRawMany<{ media: string }>();

    if (!groups.length) return 0;

    let forced = 0;
    for (const group of groups) {
      const rows = await this.observedRepository.find({
        where: {
          mediaUniqueId: group.media,
          status: In([ObservedStatus.PENDING, ObservedStatus.SCORED]),
        },
      });
      for (const row of rows) {
        if (row.forced) continue;
        // Guarded: строку мог одновременно забрать селектор (SELECTED/DELIVERED).
        const result = await this.observedRepository.update(
          { id: row.id, status: In([ObservedStatus.PENDING, ObservedStatus.SCORED]) },
          {
            forced: true,
            status: ObservedStatus.SCORED,
            evalStage: EvalStage.FINAL,
            rejectReason: null,
            evaluatedAt: row.evaluatedAt ?? now,
          }
        );
        if ((result.affected ?? 0) === 0) continue;
        forced += 1;
      }
    }
    return forced;
  }

  /**
   * Conditional write: применяется, только пока строка держит `expectedStatus`.
   * Так поздняя оценка не откатывает карточку, которую параллельный select-цикл
   * уже перевёл в SELECTED/DELIVERED (иначе возможен дубль карточки).
   */
  private async guardUpdate(
    id: number,
    expectedStatus: ObservedStatus,
    patch: Partial<ObservedPostEntity>
  ): Promise<boolean> {
    const result = await this.observedRepository.update({ id, status: expectedStatus }, patch);
    return (result.affected ?? 0) > 0;
  }

  private async reject(
    candidate: ObservedPostEntity,
    reason: string,
    expectedStatus: ObservedStatus
  ): Promise<boolean> {
    const evaluatedAt = this.clock.now();
    const patch: Partial<ObservedPostEntity> = {
      status: ObservedStatus.REJECTED,
      rejectReason: reason,
      evaluatedAt,
    };
    const written = await this.guardUpdate(candidate.id, expectedStatus, patch);
    if (!written) {
      this.logger.debug(
        `Parser evaluate: строка ${candidate.id} уже выбрана/доставлена — отказ пропущен`
      );
      return false;
    }
    Object.assign(candidate, patch);
    return true;
  }

  private async bumpSourceSelections(source: SourceChannelEntity): Promise<void> {
    source.selectedTotal += 1;
    await this.registry.repository.save(source);
  }

  private async bumpSourceRejections(source: SourceChannelEntity): Promise<void> {
    source.rejectedTotal += 1;
    await this.registry.repository.save(source);
  }

  private reactionResults(message: Api.Message): Array<{ emoji: string; count: number }> {
    const results = message.reactions?.results ?? [];
    return results
      .map((item) => {
        const count = Number(item.count ?? 0);
        return {
          emoji: item.reaction instanceof Api.ReactionEmoji ? item.reaction.emoticon : '',
          count: Number.isFinite(count) ? count : 0,
        };
      })
      .filter((item) => item.emoji.length > 0);
  }

  private async pace(baseMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, baseMs + Math.floor(this.random.next() * 200));
      timer.unref?.();
    });
  }
}
