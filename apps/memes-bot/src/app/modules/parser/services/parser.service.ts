import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import { ParserMtprotoGuard } from './parser-mtproto-guard.service';
import { BOT } from '../../bot/providers/bot.provider';
import { Bot } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';
import {
  STATS_ERROR_BACKOFF_MS,
  STATS_GAP_MS,
  STATS_SOURCES_PER_RUN,
} from '../constants/parser.constants';
import { compareStatsOrder } from '../domain/parser-rotation';

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
  private busy = { sweep: false, evaluate: false, select: false, discovery: false, stats: false, rollup: false };

  constructor(
    private readonly settings: ParserSettingsService,
    private readonly registry: ParserRegistryService,
    private readonly collector: ParserCollectorService,
    private readonly evaluator: ParserEvaluatorService,
    private readonly selector: ParserSelectorService,
    private readonly discovery: ParserDiscoveryService,
    private readonly moderation: ParserModerationService,
    private readonly parserClient: ParserClientService,
    private readonly clientBase: ClientBaseService,
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
    private readonly guard: ParserMtprotoGuard
  ) {}

  public onModuleInit(): void {
    this.moderation.registerCallbacks();
    this.registerMoreHandlers();
    this.scheduleLiveAttach();
  }

  /** «Насыпать ещё»: кнопка на последней карточке и команда/пост `/more`. */
  private registerMoreHandlers(): void {
    this.bot.callbackQuery(/^prs:more:(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) {
        await ctx.answerCallbackQuery('Только владелец');
        return;
      }
      await ctx.answerCallbackQuery('Насыпаю…');
      const delivered = await this.selector.dumpMore();
      this.logger.log(`Parser selector: /more по кнопке → ${delivered}`);
      if (delivered === 0) {
        const notice = await this.bot.api.sendMessage(
          this.config.userRequestMemeChannel,
          '🍲 Пока нечего показать: свежих оценённых постов нет.',
          { disable_notification: true }
        );
        setTimeout(() => {
          void this.bot.api
            .deleteMessage(this.config.userRequestMemeChannel, notice.message_id)
            .catch(() => undefined);
        }, 15_000).unref?.();
      }
    });

    this.bot.on('channel_post:text', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId !== this.config.userRequestMemeChannel) return;
      const text = (ctx.channelPost?.text ?? '').trim();
      // Синонимы «насыпать ещё» — только в канале модерации (предложки).
      if (!/^\/?(?:more|ещё|еще|больше|насыпь)(?:@\w+)?$/i.test(text)) return;
      const delivered = await this.selector.dumpMore();
      this.logger.log(`Parser selector: /more из канала → ${delivered}`);
      try {
        await ctx.api.deleteMessage(chatId, ctx.channelPost.message_id);
      } catch {
        // сообщение могло уже улететь — не критично
      }
      if (delivered === 0) {
        const notice = await ctx.api.sendMessage(
          chatId,
          '🍲 Пока нечего показать: свежих оценённых постов нет.',
          { disable_notification: true }
        );
        setTimeout(() => {
          void ctx.api.deleteMessage(chatId, notice.message_id).catch(() => undefined);
        }, 15_000).unref?.();
      }
    });
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

  /**
   * Оценка кандидатов, каждые 15 минут: первичная оценка pre/final, затем
   * актуализация уже оценённого пула (перечитать метрики и пересечения).
   */
  @Cron('*/15 * * * *', { timeZone: 'Europe/Moscow' })
  public async onEvaluate(): Promise<void> {
    if (!this.enabled || this.busy.evaluate) return;
    this.busy.evaluate = true;
    try {
      await this.runJob('evaluate', async () => {
        const evaluated = await this.evaluator.evaluateDue();
        const refreshed = await this.evaluator.refreshScored();
        const { expired, forced } = this.evaluator.lastEvaluateStats;
        this.logger.log(
          `Parser evaluate: evaluated=${evaluated} refreshed=${refreshed} expired=${expired} forced=${forced}`
        );
      });
    } finally {
      this.busy.evaluate = false;
    }
  }

  /**
   * Каждые 20 минут: форс-посты уходят сразу, затем авто-выдача лучших
   * оценённых постов в предложку (дневной разгон и кап на источник внутри
   * селектора), затем старение бэклога.
   * Ручной «Ещё 20»/`/more` остаётся добором поверх.
   */
  @Cron('*/20 * * * *', { timeZone: 'Europe/Moscow' })
  public async onSelect(): Promise<void> {
    if (!this.enabled || this.busy.select) return;
    this.busy.select = true;
    try {
      await this.runJob('select', async () => {
        const quota = await this.selector.remainingQuota();
        const forced = await this.selector.deliverForced();
        const delivered = await this.selector.deliverDue();
        await this.selector.ageBacklog();
        const backlog = await this.selector.countBacklog();
        this.logger.log(
          `Parser select: delivered=${delivered} quota=${quota} backlog=${backlog} forced=${forced}`
        );
      });
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
      await this.runJob('discovery', async () => {
        const { checked, deferred } = await this.discovery.runWebCheck();
        // Отложенные (пустой бюджет metadata/пауза) — не проверки: лог не должен
        // рапортовать 10 проверок, когда часть кандидатов отложена.
        this.logger.log(`Parser discovery: checked=${checked} deferred=${deferred}`);
      });
    } finally {
      this.busy.discovery = false;
    }
  }

  /**
   * Прогон статистики источников — ежечасно, ротационной порцией (TGB-125):
   * не больше `STATS_SOURCES_PER_RUN` (20) самых давних `statsUpdatedAt`
   * (NULLS FIRST), пауза `STATS_GAP_MS` между вызовами, стоп на пустой полосе
   * `metadata` (20/час) или паузе MTProto. Полный проход всех источников
   * `channels.GetFullChannel` без бюджета и был одним из источников суточного
   * FloodWait.
   */
  @Cron('20 * * * *', { timeZone: 'Europe/Moscow' })
  public async onStatsHourly(): Promise<void> {
    if (!this.enabled || this.busy.stats) return;
    this.busy.stats = true;
    try {
      await this.runJob('stats', async () => {
        const client = this.parserClient.client();
        if (!client) return;

        const all = await this.registry.listCollectible();
        // Источник, чей `getFullChannel` падал в последние сутки, не ставим
        // первым в очередь: `statsUpdatedAt` у него не двигается, и без
        // бэкоффа он жёг бы токен каждый час (NULLS FIRST навсегда).
        const nowMs = Date.now();
        const sources = all.filter((source) => !this.inStatsErrorBackoff(source, nowMs));
        if (sources.length !== all.length) {
          this.logger.debug(`Parser stats: отложено из-за недавней ошибки: ${all.length - sources.length}`);
        }
        const selected = sources.sort(compareStatsOrder).slice(0, STATS_SOURCES_PER_RUN);
        let updated = 0;
        let skippedBudget = 0;
        let skippedBlocked = 0;

        for (const [index, source] of selected.entries()) {
          // Пауза MTProto и пустая полоса metadata — разные причины останова:
          // остаток порции остаётся в голове ротации и уйдёт следующим прогоном.
          if (this.guard.isBlocked()) {
            skippedBlocked = selected.length - index;
            break;
          }
          if (!this.guard.hasBudget('metadata')) {
            skippedBudget = selected.length - index;
            break;
          }
          const before = this.statsUpdatedAtMs(source);
          try {
            const result = await this.registry.refreshSourceStats(source, client);
            // Счётчик — по реально сдвинутой метке: короткое замыкание guard-а
            // оставляет её прежней (см. `refreshSourceStats`).
            if (result != null && this.statsUpdatedAtMs(result) !== before) updated += 1;
          } catch (error) {
            this.logger.warn(`Parser stats: источник ${source.chatId}: ${error}`);
          }
          await this.guard.pace(STATS_GAP_MS);
        }

        this.logger.log(
          `Parser stats: selected=${selected.length} updated=${updated} skippedBudget=${skippedBudget} skippedBlocked=${skippedBlocked}`
        );
      });
    } finally {
      this.busy.stats = false;
    }
  }

  /**
   * Суточный пересчёт интереса: вес источников и снятие пауз. Только БД,
   * ни одного MTProto-вызова — поэтому без порции и бюджета (TGB-125).
   */
  @Cron('0 5 * * *', { timeZone: 'Europe/Moscow' })
  public async onStats(): Promise<void> {
    if (!this.enabled || this.busy.rollup) return;
    this.busy.rollup = true;
    try {
      await this.runJob('stats-rollup', async () => {
        await this.registry.refreshInterest();
        const released = await this.registry.refreshCooldowns();
        if (released) this.logger.log(`Parser stats: вернулось из паузы источников: ${released}`);
      });
    } finally {
      this.busy.rollup = false;
    }
  }

  /** Источник недавно падал в `getFullChannel` — часовая порция его не берёт. */
  private inStatsErrorBackoff(
    source: { lastErrorAt?: Date | string | null },
    nowMs: number
  ): boolean {
    const last = source.lastErrorAt;
    if (last == null) return false;
    return nowMs - new Date(last).getTime() < STATS_ERROR_BACKOFF_MS;
  }

  /** Метка `statsUpdatedAt` в мс (или `null`) — для счёта реальных обновлений. */
  private statsUpdatedAtMs(source: { statsUpdatedAt?: Date | string | null }): number | null {
    const value = source?.statsUpdatedAt;
    return value == null ? null : new Date(value).getTime();
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
