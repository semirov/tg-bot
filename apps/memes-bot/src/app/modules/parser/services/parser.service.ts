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
import { BOT } from '../../bot/providers/bot.provider';
import { Bot } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';

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
    private readonly clientBase: ClientBaseService,
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService
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
    });

    this.bot.on('channel_post:text', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId !== this.config.userRequestMemeChannel) return;
      const text = (ctx.channelPost?.text ?? '').trim();
      if (!/^\/more(@\w+)?$/.test(text)) return;
      const delivered = await this.selector.dumpMore();
      this.logger.log(`Parser selector: /more из канала → ${delivered}`);
      try {
        await ctx.api.deleteMessage(chatId, ctx.channelPost.message_id);
      } catch {
        // сообщение могло уже улететь — не критично
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

  /**
   * Каждые 20 минут: доставляем только форс-посты (обычные — по требованию
   * кнопкой/`/more`) и состариваем бэклог.
   */
  @Cron('*/20 * * * *', { timeZone: 'Europe/Moscow' })
  public async onSelect(): Promise<void> {
    if (!this.enabled || this.busy.select) return;
    this.busy.select = true;
    try {
      await this.runJob('select', async () => {
        await this.selector.deliverForced();
        await this.selector.ageBacklog();
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
      await this.runJob('discovery', () => this.discovery.runWebCheck());
    } finally {
      this.busy.discovery = false;
    }
  }

  /** Статистика источников (базлайны, подписчики, ERR, вес/cooldown), раз в сутки. */
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
        const released = await this.registry.refreshCooldowns();
        if (released) this.logger.log(`Parser stats: вернулось из паузы источников: ${released}`);
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
