import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Gauge } from 'prom-client';
import { IsNull, Repository } from 'typeorm';

import { metrics, setGaugeCollector } from '../../shared/metrics';
import { PostSchedulerEntity } from '../bot/entities/post-scheduler.entity';
import { UserEntity } from '../bot/entities/user.entity';
import { ObservatoryPostEntity } from '../observatory/entities/observatory-post.entity';
import { ObservedPostEntity } from '../parser/entities/observed-post.entity';
import { SourceChannelEntity } from '../parser/entities/source-channel.entity';

/**
 * Наполняет бизнес-гейджи из БД в момент scrape: prom-client вызывает
 * `collect` при рендере `/metrics`, поэтому отдельный таймер не нужен и
 * значения всегда свежие.
 */
@Injectable()
export class MetricsCollectorService implements OnModuleInit {
  constructor(
    @InjectRepository(SourceChannelEntity)
    private readonly sources: Repository<SourceChannelEntity>,
    @InjectRepository(ObservedPostEntity)
    private readonly candidates: Repository<ObservedPostEntity>,
    @InjectRepository(ObservatoryPostEntity)
    private readonly observatory: Repository<ObservatoryPostEntity>,
    @InjectRepository(PostSchedulerEntity)
    private readonly scheduler: Repository<PostSchedulerEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>
  ) {}

  public onModuleInit(): void {
    setGaugeCollector(metrics.parser.sourcesByStatus, () => this.collectSources());
    setGaugeCollector(metrics.parser.candidatesByStatus, () => this.collectCandidates());
    setGaugeCollector(metrics.observatory.pending, () => this.collectObservatoryPending());
    setGaugeCollector(metrics.observatory.scheduledPending, () => this.collectScheduledPending());
    setGaugeCollector(metrics.users.total, () => this.collectUsers());
  }

  /** Пересчитывает все бизнес-гейджи. */
  public async collect(): Promise<void> {
    await Promise.all([
      this.collectSources(),
      this.collectCandidates(),
      this.collectObservatoryPending(),
      this.collectScheduledPending(),
      this.collectUsers(),
    ]);
  }

  private collectSources(): Promise<void> {
    return this.collectGrouped(this.sources, 'source', metrics.parser.sourcesByStatus);
  }

  private collectCandidates(): Promise<void> {
    return this.collectGrouped(this.candidates, 'candidate', metrics.parser.candidatesByStatus);
  }

  private async collectObservatoryPending(): Promise<void> {
    const count = await this.observatory.count({ where: { isApproved: IsNull() } });
    metrics.observatory.pending.set(count);
  }

  private async collectScheduledPending(): Promise<void> {
    const count = await this.scheduler.count({ where: { isPublished: false } });
    metrics.observatory.scheduledPending.set(count);
  }

  private async collectUsers(): Promise<void> {
    const count = await this.users.count();
    metrics.users.total.set(count);
  }

  /** Считает строки по колонке `status` и проставляет в гейдж. */
  private async collectGrouped(
    repository: Repository<unknown>,
    alias: string,
    gauge: Gauge<string>
  ): Promise<void> {
    const rows = await repository
      .createQueryBuilder(alias)
      .select(`${alias}.status`, 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy(`${alias}.status`)
      .getRawMany<{ status: string; count: string }>();

    gauge.reset();
    for (const row of rows) {
      gauge.set({ status: row.status }, Number(row.count));
    }
  }
}
