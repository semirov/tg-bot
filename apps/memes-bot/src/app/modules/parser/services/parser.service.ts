import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TelegramClient } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { metrics } from '../../../shared/metrics';
import { ClientBaseService } from '../../client/services/client-base.service';
import { ParserClientService } from './parser-client.service';
import { ParserSettingsService } from './parser-settings.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserCollectorService } from './parser-collector.service';
import { ParserEvaluatorService } from './parser-evaluator.service';
import { ParserSelectorService } from './parser-selector.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { ParserModerationService } from './parser-moderation.service';

/**
 * Оркестратор парсера: регистрация callback-обработчиков, подключение
 * live-событий юзербота и cron-прогоны (sweep → evaluate → select →
 * discovery → stats). Работает параллельно с обсерваторией.
 */
@Injectable()
export class ParserService implements OnModuleInit {
  private readonly logger = new Logger(ParserService.name);
  private liveHandlerAttached = false;
  private liveAttachTimer?: NodeJS.Timeout;
  private lastAttachedClient?: unknown;
  private busy = { sweep: false, evaluate: false, select: false, discovery: false, stats: false };

  constructor(
    private readonly settings: ParserSettingsService,
    private readonly registry: ParserRegistryService,
    private readonly collector: ParserCollectorService,
    private readonly evaluator: ParserEvaluatorService,
    private readonly selector: ParserSelectorService,
    private readonly discovery: ParserDiscoveryService,
    private readonly moderation: ParserModerationService,
    private readonly parserClient: ParserClientService,
    private readonly clientBase: ClientBaseService
  ) {}

  public onModuleInit(): void {
    this.moderation.registerCallbacks();
    this.scheduleLiveAttach();
  }

  /**
   * Подключает live-обработчик, переподключая его при пересоздании клиента
   * (переключение обсерватории делает новый TelegramClient).
   */
  private scheduleLiveAttach(): void {
    this.liveAttachTimer = setInterval(() => {
      if (!this.settings.enabled) return;
      const client = this.clientBase.activeClient as TelegramClient | undefined;
      // В тестовых стабах activeClient может быть чем угодно — требуем контракт.
      if (!client || typeof client.addEventHandler !== 'function') return;
      if (this.liveHandlerAttached && client === this.lastAttachedClient) return;
      client.addEventHandler(async (event) => {
        await this.safeLive(event);
      }, new NewMessage({}));
      this.liveHandlerAttached = true;
      this.lastAttachedClient = client;
      this.logger.log('Parser: live-обработчик подключен к юзерботу');
    }, 30_000);
    this.liveAttachTimer.unref?.();
  }

  private async safeLive(event: NewMessageEvent): Promise<void> {
    try {
      await this.collector.onLiveEvent(event);
    } catch (error) {
      this.logger.warn(`Parser live: ошибка обработки: ${error}`);
    }
  }

  private get enabled(): boolean {
    return this.settings.enabled;
  }

  /** History sweep по источникам, каждые 30 минут. */
  @Cron('*/30 * * * *', { timeZone: 'Europe/Moscow' })
  public async onSweep(): Promise<void> {
    if (!this.enabled || this.busy.sweep) return;
    this.busy.sweep = true;
    try {
      await this.runJob('sweep', () => this.collector.sweepAll());
    } finally {
      this.busy.sweep = false;
    }
  }

  /** Оценка кандидатов, каждые 15 минут. */
  @Cron('*/15 * * * *', { timeZone: 'Europe/Moscow' })
  public async onEvaluate(): Promise<void> {
    if (!this.enabled || this.busy.evaluate) return;
    this.busy.evaluate = true;
    try {
      await this.runJob('evaluate', () => this.evaluator.evaluateDue());
    } finally {
      this.busy.evaluate = false;
    }
  }

  /** Отбор и доставка, каждые 20 минут. */
  @Cron('*/20 * * * *', { timeZone: 'Europe/Moscow' })
  public async onSelect(): Promise<void> {
    if (!this.enabled || this.busy.select) return;
    this.busy.select = true;
    try {
      await this.runJob('select', () => this.selector.selectAndDeliver());
    } finally {
      this.busy.select = false;
    }
  }

  /** Discovery: web-check кандидатов, каждые 3 часа. */
  @Cron('7 */3 * * *', { timeZone: 'Europe/Moscow' })
  public async onDiscovery(): Promise<void> {
    if (!this.enabled || this.busy.discovery) return;
    this.busy.discovery = true;
    try {
      await this.runJob('discovery', () => this.discovery.runWebCheck());
    } finally {
      this.busy.discovery = false;
    }
  }

  /** Статистика источников (базлайны, подписчики, ERR) + прунинг, раз в сутки. */
  @Cron('0 5 * * *', { timeZone: 'Europe/Moscow' })
  public async onStats(): Promise<void> {
    if (!this.enabled || this.busy.stats) return;
    this.busy.stats = true;
    try {
      await this.runJob('stats', async () => {
        const client = this.parserClient.client();
        if (!client) return;

        const sources = await this.registry.listCollectible();
        for (const source of sources) {
          try {
            await this.registry.refreshSourceStats(source, client);
          } catch (error) {
            this.logger.warn(`Parser stats: источник ${source.chatId}: ${error}`);
          }
        }
        const disabled = await this.registry.pruneWeakSources();
        if (disabled) this.logger.log(`Parser stats: прунинг отключил ${disabled} источников`);
      });
    } finally {
      this.busy.stats = false;
    }
  }

  /**
   * Общая обёртка cron-задач: длительность, исход и время последнего успеха.
   * Ошибку не пробрасывает — расписание не должно падать от одного сбоя.
   */
  private async runJob(job: string, fn: () => Promise<unknown>): Promise<void> {
    const stopTimer = metrics.parser.jobDuration.startTimer({ job });
    try {
      await fn();
      metrics.parser.jobRuns.inc({ job, result: 'ok' });
      metrics.parser.jobLastSuccess.set({ job }, Date.now() / 1000);
    } catch (error) {
      metrics.parser.jobRuns.inc({ job, result: 'error' });
      this.logger.warn(`Parser job ${job}: ошибка: ${error}`);
    } finally {
      stopTimer();
    }
  }
}
