import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Menu, MenuFlavor, MenuRange } from '@grammyjs/menu';
import { Bot } from 'grammy';
import { Repository } from 'typeorm';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { AdminMenusEnum } from '../../menus/constants/bot-menus.enum';
import { MenuPresenter } from '../../menus/menu-presenter';
import {
  CandidateVerdict,
  DISCOVERY_REVIEW_LIMIT,
  ObservedStatus,
  SourceCategory,
  SourceStatus,
} from '../constants/parser.constants';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserDeliveryService } from './parser-delivery.service';
import { ParserDiscoveryService } from './parser-discovery.service';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSettingsService } from './parser-settings.service';

/**
 * Админ-меню «🧭 Парсер»: тумблеры конвейера, пороги, источники,
 * очередь кандидатов discovery, статистика.
 */
@Injectable()
export class ParserMenuService implements OnModuleInit {
  private menu: Menu<BotContext>;

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly settings: ParserSettingsService,
    private readonly registry: ParserRegistryService,
    private readonly discovery: ParserDiscoveryService,
    private readonly delivery: ParserDeliveryService
  ) {}

  /** Stateless-хелпер сборки меню (без DI, чтобы не тянуть MenuModule). */
  private readonly menuPresenter = new MenuPresenter();

  public onModuleInit(): void {
    this.menu = this.buildMenu();
  }

  /** Готовое меню для регистрации в админ-старте (AdminMenuService). */
  public getMenu(): Menu<BotContext> {
    if (!this.menu) this.menu = this.buildMenu();
    return this.menu;
  }

  private buildMenu(): Menu<BotContext> {
    const settings = () => this.settings.current;
    const guard = (handler: (ctx: BotContext & MenuFlavor) => Promise<void> | void) =>
      this.menuPresenter.ownerGuard(handler);

    const menu = new Menu<BotContext>(AdminMenusEnum.PARSER_SETTINGS_MENU);

    menu.text(
      async () =>
        `🧭 Парсер ${settings().enabled ? '🟢' : '⚪️'} · лимит ${settings().dailyLimit}/сутки · ${await this.statsLine()}`,
      guard(async (ctx) => ctx.menu.update())
    ).row();

    menu.text(
      () => `Конвейер: ${settings().enabled ? '🟢 вкл' : '⚪️ выкл'}`,
      guard(async (ctx) => {
        await this.settings.update({ enabled: !settings().enabled });
        ctx.menu.update();
      })
    ).row();

    menu.text(
      () => `Лимит/сутки: ${settings().dailyLimit}`,
      guard(async (ctx) => {
        await this.settings.update({ dailyLimit: cycle(settings().dailyLimit, [6, 10, 12, 15, 20]) });
        ctx.menu.update();
      })
    )
      .text(
        () => `Лимит/источник: ${settings().sourceDailyCap}`,
        guard(async (ctx) => {
          await this.settings.update({ sourceDailyCap: cycle(settings().sourceDailyCap, [1, 2, 3]) });
          ctx.menu.update();
        })
      )
      .row();

    menu.text(
      () => `Кринж-доля: ${Math.round(settings().cringeShare * 100)}%`,
      guard(async (ctx) => {
        await this.settings.update({ cringeShare: cycle(settings().cringeShare, [0.1, 0.25, 0.5]) });
        ctx.menu.update();
      })
    )
      .text(
        () => `ERR min: ${Math.round(settings().errMin * 100)}%`,
        guard(async (ctx) => {
          await this.settings.update({ errMin: cycle(settings().errMin, [0.1, 0.15, 0.25]) });
          ctx.menu.update();
        })
      )
      .row();

    menu.text(
      () => `Финал через ${settings().evalFinalHours}ч`,
      guard(async (ctx) => {
        await this.settings.update({ evalFinalHours: cycle(settings().evalFinalHours, [4, 8, 12, 24]) });
        ctx.menu.update();
      })
    )
      .text(
        () => `Макс. источников: ${settings().maxSources}`,
        guard(async (ctx) => {
          await this.settings.update({ maxSources: cycle(settings().maxSources, [10, 20, 30]) });
          ctx.menu.update();
        })
      )
      .row();

    menu.text(
      () => `AI (DeepSeek): ${settings().aiEnabled ? '🟢' : '⚪️'}`,
      guard(async (ctx) => {
        await this.settings.update({ aiEnabled: !settings().aiEnabled });
        ctx.menu.update();
      })
    )
      .text(
        '📥 Импорт подписок',
        guard(async (ctx) => {
          const created = await this.registry.importSubscriptions();
          await ctx.answerCallbackQuery(`Импортировано: ${created}`);
          ctx.menu.update();
        })
      )
      .row();

    menu.text(
      async () => `Источники: ${await this.registry.countCollectible()}/${settings().maxSources}`,
      guard(async (ctx) => ctx.menu.update())
    ).row();

    menu.dynamic(async () => {
      const range = new MenuRange<BotContext>();
      const sources = await this.registry.listAll();
      for (const source of sources.slice(0, 12)) {
        range
          .text(
            sourceButtonLabel(source),
            guard(async (ctx) => {
              await this.registry.toggleStatus(source.id);
              await ctx.answerCallbackQuery('Статус переключён');
              ctx.menu.update();
            })
          )
          .text(
            source.category === SourceCategory.CRINGE ? '🤡' : '🧠',
            guard(async (ctx) => {
              const next =
                source.category === SourceCategory.CRINGE ? SourceCategory.MEMES : SourceCategory.CRINGE;
              await this.registry.setCategory(source.id, next);
              await ctx.answerCallbackQuery(`Категория: ${next}`);
              ctx.menu.update();
            })
          )
          .row();
      }
      return range;
    });

    menu.text(
      async () =>
        `Кандидаты: ${await this.discovery.repository.count({
          where: [{ verdict: CandidateVerdict.READY }, { verdict: CandidateVerdict.PENDING }],
        })}`,
      guard(async (ctx) => {
        const candidates = await this.discovery.listForReview(DISCOVERY_REVIEW_LIMIT);
        if (!candidates.length) {
          await ctx.answerCallbackQuery('Кандидатов нет');
          return;
        }
        for (const candidate of candidates) {
          await this.bot.api.sendMessage(this.ownerId(ctx), this.delivery.buildCandidateCaption(candidate), {
            parse_mode: 'HTML',
            reply_markup: this.delivery.buildCandidateKeyboard(candidate.id),
          });
        }
        await ctx.answerCallbackQuery(`Отправил карточки: ${candidates.length}`);
      })
    ).row();

    menu.text(
      '🔄 Обновить',
      guard(async (ctx) => ctx.menu.update())
    )
      .text(
        '↩️ Сброс',
        guard(async (ctx) => {
          await this.settings.reset();
          await ctx.answerCallbackQuery('Настройки сброшены');
          ctx.menu.update();
        })
      )
      .back('Назад');

    return menu;
  }

  /** Статистика для заголовка меню (собрано/оценено/доставлено сегодня). */
  public async statsLine(): Promise<string> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const [pending, scored, delivered] = await Promise.all([
      this.observedRepository.count({ where: { status: ObservedStatus.PENDING } }),
      this.observedRepository.count({ where: { status: ObservedStatus.SCORED } }),
      this.observedRepository
        .createQueryBuilder('o')
        .where('o.status IN (:...statuses)', {
          statuses: [ObservedStatus.DELIVERED, ObservedStatus.PUBLISHED, ObservedStatus.QUEUED],
        })
        .andWhere('o.deliveredAt >= :since', { since })
        .getCount(),
    ]);
    return `⏳ ${pending} · 🧮 ${scored} · ✅ ${delivered}/день`;
  }

  private ownerId(ctx: BotContext): number {
    return Number(ctx.from?.id ?? 0);
  }
}

const cycle = (value: number, presets: number[]): number => {
  const index = presets.indexOf(value);
  return presets[(index + 1) % presets.length];
};

const sourceButtonLabel = (source: SourceChannelEntity): string => {
  const icon =
    source.status === SourceStatus.DISABLED ? '⚪️' : source.status === SourceStatus.WEB_ONLY ? '🌐' : '🟢';
  const title = (source.title ?? source.username ?? source.chatId).slice(0, 22);
  return `${icon} ${title}`;
};
