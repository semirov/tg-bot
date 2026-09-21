import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Menu, MenuFlavor } from '@grammyjs/menu';
import { Bot, InlineKeyboard } from 'grammy';
import { Repository } from 'typeorm';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { AdminMenusEnum } from '../../menus/constants/bot-menus.enum';
import { MenuPresenter } from '../../menus/menu-presenter';
import { ObservedStatus, SourceStatus } from '../constants/parser.constants';
import { channelInternalId } from '../../../shared/publication/telegram-link';
import { ObservedPostEntity } from '../entities/observed-post.entity';
import { SourceChannelEntity } from '../entities/source-channel.entity';
import { ParserRegistryService } from './parser-registry.service';
import { ParserSettingsService } from './parser-settings.service';

/** Размер страницы списков. */
const PAGE_SIZE = 8;

type ListType = 'pop' | 'exc' | 'src';

/**
 * Админ-меню «🧭 Парсер»: тумблер конвейера, boost «Насыпать ещё»,
 * пагинированные списки источников (популярные/исключённые/все), сброс.
 * Ручного отбора кандидатов нет — discovery работает автоматически.
 */
@Injectable()
export class ParserMenuService implements OnModuleInit {
  private menu: Menu<BotContext>;

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    @InjectRepository(ObservedPostEntity)
    private readonly observedRepository: Repository<ObservedPostEntity>,
    private readonly settings: ParserSettingsService,
    private readonly registry: ParserRegistryService
  ) {}

  private readonly menuPresenter = new MenuPresenter();

  public onModuleInit(): void {
    this.menu = this.buildMenu();
    this.registerListCallbacks();
  }

  public getMenu(): Menu<BotContext> {
    if (!this.menu) this.menu = this.buildMenu();
    return this.menu;
  }

  /** Callback-и пагинации списков и возврата из чёрного списка. */
  private registerListCallbacks(): void {
    this.bot.callbackQuery(/^pl:(pop|exc|src):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      await ctx.answerCallbackQuery();
      await this.sendList(ctx, ctx.match?.[1] as ListType, Number(ctx.match?.[2]));
    });

    this.bot.callbackQuery(/^pl:restore:(\d+):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      const sourceId = Number(ctx.match?.[1]);
      const page = Number(ctx.match?.[2]);
      const restored = await this.registry.restoreSource(sourceId);
      await ctx.answerCallbackQuery(restored ? 'Источник возвращён' : 'Не найден');
      await this.sendList(ctx, 'exc', page);
    });

    this.bot.callbackQuery(/^pl:excl:(\d+):(pop|src):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      await ctx.answerCallbackQuery('Исключить источник?');
      await this.editListKeyboard(
        ctx,
        new InlineKeyboard()
          .text('✅ Да, исключить', `pl:exclok:${ctx.match?.[1]}:${ctx.match?.[2]}:${ctx.match?.[3]}`)
          .text('↩️ Отмена', `pl:exclno:${ctx.match?.[1]}:${ctx.match?.[2]}:${ctx.match?.[3]}`)
      );
    });

    this.bot.callbackQuery(/^pl:exclno:(\d+):(pop|src):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      await ctx.answerCallbackQuery('Отменено');
      await this.sendList(ctx, ctx.match?.[2] as ListType, Number(ctx.match?.[3]));
    });

    this.bot.callbackQuery(/^pl:exclok:(\d+):(pop|src):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      const excluded = await this.registry.excludeSource(Number(ctx.match?.[1]));
      await ctx.answerCallbackQuery(excluded ? 'Источник исключён' : 'Не найден');
      await this.sendList(ctx, ctx.match?.[2] as ListType, Number(ctx.match?.[3]));
    });
  }

  private async editListKeyboard(ctx: BotContext, keyboard: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    } catch (error) {
      void error;
    }
  }

  private buildMenu(): Menu<BotContext> {
    const settings = () => this.settings.current;
    const guard = (handler: (ctx: BotContext & MenuFlavor) => Promise<void> | void) =>
      this.menuPresenter.ownerGuard(handler);

    const menu = new Menu<BotContext>(AdminMenusEnum.PARSER_SETTINGS_MENU);

    menu.text(
      async () => `🧭 Парсер ${settings().enabled ? '🟢' : '⚪️'} · ${await this.statsLine()}`,
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
      () => `ERR min: ${Math.round(settings().errMin * 100)}%`,
      guard(async (ctx) => {
        await this.settings.update({ errMin: cycle(settings().errMin, [0.1, 0.15, 0.25, 0.35]) });
        ctx.menu.update();
      })
    )
      .text(
        () => `Финал через ${settings().evalFinalHours}ч`,
        guard(async (ctx) => {
          await this.settings.update({ evalFinalHours: cycle(settings().evalFinalHours, [4, 8, 12, 24]) });
          ctx.menu.update();
        })
      )
      .row();

    menu.text(
      () => `👴 Старый парсер: ${settings().legacyEnabled ? '🟢 вкл' : '⚪️ выкл'}`,
      guard(async (ctx) => {
        await this.settings.update({ legacyEnabled: !settings().legacyEnabled });
        await ctx.answerCallbackQuery(
          settings().legacyEnabled ? 'Старый парсер включён' : 'Старый парсер выключен'
        );
        ctx.menu.update();
      })
    ).row();

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
      async () => `🏆 Популярные (${await this.registry.countPopular()})`,
      guard(async (ctx) => this.sendList(ctx, 'pop', 0))
    )
      .text('🚫 Исключённые', guard(async (ctx) => this.sendList(ctx, 'exc', 0)))
      .row();

    menu.text(
      async () => `📚 Все источники (${await this.registry.countCollectible()})`,
      guard(async (ctx) => this.sendList(ctx, 'src', 0))
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

  /** Отправляет/перерисовывает пагинированный список источников. */
  public async sendList(ctx: BotContext, type: ListType, page: number): Promise<void> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
    const { rows, total, title } = await this.listPage(type, safePage);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const lines = [
      `${title} · стр. ${safePage + 1}/${pages}`,
      ...(rows.length ? rows.map((source, index) => this.sourceLine(source, safePage * PAGE_SIZE + index + 1)) : ['— пусто —']),
    ];
    const keyboard = this.listKeyboard(type, safePage, pages, rows);
    const text = lines.join('\n');
    const isEdit = Boolean(ctx.callbackQuery);
    try {
      if (isEdit) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await this.bot.api.sendMessage(Number(ctx.from?.id ?? 0), text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
    } catch (error) {
      void error;
    }
  }

  private async listPage(
    type: ListType,
    page: number
  ): Promise<{ rows: SourceChannelEntity[]; total: number; title: string }> {
    if (type === 'pop') {
      const [rows, total] = await Promise.all([
        this.registry.listPopular(PAGE_SIZE, page * PAGE_SIZE),
        this.registry.countPopular(),
      ]);
      return { rows, total, title: '🏆 Популярные источники' };
    }
    if (type === 'exc') {
      const [all, total] = await Promise.all([
        this.registry.listExcluded(),
        this.registry.countExcluded(),
      ]);
      return {
        rows: all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
        total,
        title: '🚫 Исключённые источники',
      };
    }
    const all = await this.registry.listCollectible();
    return {
      rows: all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
      total: all.length,
      title: '📚 Все источники',
    };
  }

  private listKeyboard(
    type: ListType,
    page: number,
    pages: number,
    rows: SourceChannelEntity[]
  ): InlineKeyboard {
    const matrix: Array<Array<{ text: string; callback_data: string }>> = [];
    let actions: Array<{ text: string; callback_data: string }> = [];
    rows.forEach((source, index) => {
      const label = `${index + 1 + page * PAGE_SIZE}`;
      if (type === 'exc') {
        actions.push({ text: `↩️ Вернуть ${label}`, callback_data: `pl:restore:${source.id}:${page}` });
      } else {
        actions.push({ text: `🚫 ${label}`, callback_data: `pl:excl:${source.id}:${type}:${page}` });
      }
      if (actions.length === 4) {
        matrix.push(actions);
        actions = [];
      }
    });
    if (actions.length) matrix.push(actions);

    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) nav.push({ text: '⬅️', callback_data: `pl:${type}:${page - 1}` });
    if (page < pages - 1) nav.push({ text: '➡️', callback_data: `pl:${type}:${page + 1}` });
    if (nav.length) matrix.push(nav);

    return InlineKeyboard.from(matrix);
  }

  private sourceLine(source: SourceChannelEntity, position: number): string {
    const icon =
      source.excluded ? '🚫' : source.status === SourceStatus.WEB_ONLY ? '🌐' : '🟢';
    const title = escapeHtml((source.title ?? source.username ?? source.chatId).slice(0, 30));
    const link = this.channelLink(source);
    const named = link ? `<a href="${link}"><b>${title}</b></a>` : `<b>${title}</b>`;
    const taken = source.takenTotal ?? 0;
    const weight = (source.weight ?? 1).toFixed(2);
    const err = source.err != null ? ` · ERR ${(source.err * 100).toFixed(1)}%` : '';
    return `${position}. ${icon} ${named} — взято ${taken} · вес ${weight}${err}`;
  }

  /** Публичная ссылка на источник (username или внутренняя форма канала). */
  public channelLink(source: SourceChannelEntity): string | null {
    if (source.username) return `https://t.me/${source.username}`;
    const numeric = Number(source.chatId);
    if (!source.chatId || !Number.isFinite(numeric) || numeric === 0) return null;
    const internal = channelInternalId(numeric);
    return internal ? `https://t.me/c/${internal}` : null;
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
}

const cycle = (value: number, presets: number[]): number => {
  const index = presets.indexOf(value);
  return presets[(index + 1) % presets.length];
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
