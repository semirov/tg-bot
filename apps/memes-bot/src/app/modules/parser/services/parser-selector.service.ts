import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { CLOCK, Clock } from '../../../shared/clock';
import { ObservedStatus } from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserEvaluatorService } from './parser-evaluator.service';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSettingsService } from './parser-settings.service';
import {
  QuotaRules,
  SelectCandidate,
  buildDayCounters,
  dedupBatch,
  isCringeCategory,
  pickByFairness,
} from '../domain/parser-quotas';

/**
 * Селектор: выбирает оценённых кандидатов с учётом лимитов дня, квот
 * источников/категорий и fairness, затем запускает доставку в предложку.
 */
@Injectable()
export class ParserSelectorService {
  private readonly logger = new Logger(ParserSelectorService.name);

  constructor(
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly registry: ParserRegistryService,
    private readonly evaluator: ParserEvaluatorService,
    private readonly delivery: ParserDeliveryService,
    private readonly settings: ParserSettingsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Прогон селектора (cron). Возвращает число доставленных постов. */
  public async selectAndDeliver(): Promise<number> {
    const config = this.settings.current;
    if (!this.settings.enabled) return 0;

    const scored = await this.observedRepository.find({
      where: { status: ObservedStatus.SCORED },
      order: { score: 'DESC' },
      take: 200,
    });

    const eligible = scored.filter((row) => this.evaluator.isEligible(row));
    if (!eligible.length) return 0;

    const since = this.startOfDay();
    const todayRows = await this.observedRepository
      .createQueryBuilder('o')
      .where('o.status IN (:...statuses)', {
        statuses: [
          ObservedStatus.DELIVERED,
          ObservedStatus.PUBLISHED,
          ObservedStatus.QUEUED,
        ],
      })
      .andWhere('o.deliveredAt >= :since', { since })
      .take(500)
      .getMany();

    const sources = await this.loadSources([
      ...eligible.map((row) => row.sourceChatId),
      ...todayRows.map((row) => row.sourceChatId),
    ]);

    const rules: QuotaRules = {
      dailyLimit: config.dailyLimit,
      sourceDailyCap: config.sourceDailyCap,
      cringeShare: config.cringeShare,
    };
    const counters = buildDayCounters(
      todayRows.map((row) => ({
        sourceChatId: Number(row.sourceChatId),
        category: sources.get(row.sourceChatId)?.category ?? 'memes',
        cringe: isCringeCategory(sources.get(row.sourceChatId)?.category ?? 'memes'),
        at: row.deliveredAt ?? since,
      })),
      since,
      (item) => item.at
    );

    const remaining = Math.max(0, rules.dailyLimit - counters.total);
    if (remaining === 0) {
      this.logger.debug('Parser selector: дневной лимит исчерпан');
      return 0;
    }

    // Дедуп внутри батча: остаётся лучший по score на каждое уникальное медиа.
    const uniqueIds = dedupBatch(
      eligible.map((row) => ({ id: row.id, score: row.score ?? 0, fileKey: row.mediaUniqueId }))
    );
    const uniqueById = new Map(eligible.map((row) => [row.id, row]));
    const unique = uniqueIds.map((id) => uniqueById.get(id)).filter((row): row is ObservedPostEntity => !!row);

    // Кросс-прогонный дедуп: это медиа уже уезжало в предложку/публикацию.
    const alreadyUsed = await this.findDeliveredMediaIds(
      unique.map((row) => row.mediaUniqueId).filter((value): value is string => !!value)
    );
    const fresh = unique.filter((row) => !alreadyUsed.has(row.mediaUniqueId ?? ''));

    const candidates: SelectCandidate[] = fresh.map((row) => ({
      id: row.id,
      sourceChatId: Number(row.sourceChatId),
      category: sources.get(row.sourceChatId)?.category ?? 'memes',
      score: row.score ?? 0,
      stage: row.evalStage,
    }));

    const pickedIds = pickByFairness(candidates, rules, counters);
    if (!pickedIds.length) {
      this.logger.debug('Parser selector: квоты не пропустили ни одного кандидата');
      return 0;
    }

    let delivered = 0;
    for (const id of pickedIds) {
      const row = uniqueById.get(id);
      if (!row) continue;

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
      } else if (result.status === ObservedStatus.FAILED) {
        // Технический сбой — вернём в score, попробуем в следующем прогоне.
        row.status = ObservedStatus.SCORED;
        await this.observedRepository.save(row);
      }
    }

    if (delivered) this.logger.log(`Parser selector: доставлено ${delivered} постов`);
    return delivered;
  }

  private async loadSources(
    chatIds: ReadonlyArray<string>
  ): Promise<Map<string, SourceChannelEntity>> {
    const ids = [...new Set(chatIds)];
    const sources = await this.registry.repository.find({ where: { chatId: In(ids) } });
    return new Map(sources.map((source) => [source.chatId, source]));
  }

  private startOfDay(): Date {
    const now = this.clock.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  private async findDeliveredMediaIds(mediaIds: ReadonlyArray<string>): Promise<Set<string>> {
    if (!mediaIds.length) return new Set();
    const rows = await this.observedRepository.find({
      where: {
        mediaUniqueId: In([...mediaIds]),
        status: In([
          ObservedStatus.DELIVERED,
          ObservedStatus.PUBLISHED,
          ObservedStatus.QUEUED,
          ObservedStatus.SELECTED,
        ]),
      },
      take: 500,
    });
    return new Set(rows.map((row) => row.mediaUniqueId ?? ''));
  }
}
