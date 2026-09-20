import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { TotalList } from 'telegram/Helpers';
import { CLOCK, Clock } from '../../../shared/clock';
import { RANDOM, Random } from '../../../shared/random';
import { EvalStage, ObservedStatus } from '../constants/parser.constants';
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

/**
 * Оценщик: перечитывает кандидатов через messages.getMessages, нормирует
 * просмотры/реакции по базлайну канала и выставляет скор/вердикт.
 */
@Injectable()
export class ParserEvaluatorService {
  private readonly logger = new Logger(ParserEvaluatorService.name);

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

  /** Оценка кандидатов (cron): pre-оценка, финал, истечение TTL. */
  public async evaluateDue(): Promise<number> {
    const client = this.parserClient.client();
    if (!client) return 0;

    const config = this.settings.current;
    const now = this.clock.now();

    const expired = await this.expireOld(now, config.candidateTtlHours);

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

    if (evaluated || expired) {
      this.logger.log(`Parser evaluate: оценено ${evaluated}, истекло ${expired}`);
    }
    return evaluated;
  }

  /** Оценка одного кандидата: перечитали метрики → посчитали → вердикт. */
  public async evaluateCandidate(
    candidate: ObservedPostEntity,
    stage: EvalStage,
    client: TelegramClient
  ): Promise<boolean> {
    const source = await this.registry.repository.findOne({
      where: { chatId: candidate.sourceChatId },
    });
    if (!source) {
      await this.reject(candidate, 'source-missing');
      return true;
    }

    let baseline = this.freshBaseline(source) ?? (await this.registry.computeBaselineFor(source));
    if (!baseline) {
      // Круг «baseline ← оценённые посты ← baseline» разрываем первичным
      // базлайном из истории канала (getHistory, read-only).
      baseline = await this.registry.seedBaselineFromHistory(source, client);
      if (!baseline) {
        this.logger.debug(`Parser evaluate: нет базлайна у ${source.chatId} — кандидат ждёт`);
        return false;
      }
    }

    const ids = [candidate.sourceMessageId, ...(candidate.groupIds ?? [])];
    const messages = await this.guard.run<TotalList<Api.Message>>('getMessages:eval', () =>
      client.getMessages(bigInt(source.rawChatId ?? source.chatId), { ids })
    );
    // Сетевая неудача guard'а — не «пост удалён»: пропускаем, повторим позже.
    if (messages === undefined) return false;
    const fresh = messages?.find((m) => m?.id === candidate.sourceMessageId);
    if (!fresh) {
      await this.reject(candidate, 'message-gone');
      return true;
    }

    const views = fresh.views ?? 0;
    const reactions = countReactions(this.reactionResults(fresh));

    if (this.settings.current.aiEnabled) {
      const aiReject = await this.ai.rejectPostIfTrash(candidate.caption);
      if (aiReject) {
        await this.reject(candidate, aiReject);
        return true;
      }
    }

    const metrics = computePostMetrics(views, reactions, baseline);
    const score = computeScore(metrics);

    candidate.views = views;
    candidate.reactions = reactions.total;
    candidate.metrics = metrics;
    candidate.score = score;
    candidate.evaluatedAt = this.clock.now();

    const passed =
      source.category === 'cringe'
        ? passesCringe(views, metrics, this.settings.current.cringeMinViews, this.settings.current.cringeShareMin)
        : passesThresholds(views, metrics, this.thresholds(), baseline);

    if (stage === EvalStage.FINAL && !passed.passed) {
      candidate.evalStage = EvalStage.FINAL;
      candidate.status = ObservedStatus.REJECTED;
      candidate.rejectReason = passed.reasons.join(';');
      await this.observedRepository.save(candidate);
      await this.bumpSourceRejections(source);
      return true;
    }

    candidate.evalStage = stage;
    candidate.status = ObservedStatus.SCORED;
    candidate.rejectReason = null;
    await this.observedRepository.save(candidate);
    await this.bumpSourceSelections(source);
    return true;
  }

  /** Готов ли кандидат к выбору селектором (финал прошёл или hot на pre). */
  public isEligible(candidate: ObservedPostEntity): boolean {
    if (candidate.status !== ObservedStatus.SCORED) return false;
    if (candidate.evalStage === EvalStage.FINAL) return !candidate.rejectReason;
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
    for (const row of stale) {
      row.status = ObservedStatus.EXPIRED;
      row.rejectReason = `ttl-${ttlHours}h`;
      await this.observedRepository.save(row);
    }
    return stale.length;
  }

  private async reject(candidate: ObservedPostEntity, reason: string): Promise<void> {
    candidate.status = ObservedStatus.REJECTED;
    candidate.rejectReason = reason;
    candidate.evaluatedAt = this.clock.now();
    await this.observedRepository.save(candidate);
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
