import { Conversation, createConversation } from '@grammyjs/conversations';
import { Menu, MenuFlavor, MenuRange } from '@grammyjs/menu';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { add, format, getUnixTime, set } from 'date-fns';
import { utcToZonedTime } from 'date-fns-tz';
import { Bot, InlineKeyboard } from 'grammy';
import { PostSchedulerEntity } from '../bot/entities/post-scheduler.entity';
import { UserEntity } from '../bot/entities/user.entity';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { BOT } from '../bot/providers/bot.provider';
import { PostSchedulerService } from '../bot/services/post-scheduler.service';
import { UserService } from '../bot/services/user.service';
import { ClientBaseService } from '../client/services/client-base.service';
import { SchedulerCommonService } from '../common/scheduler-common.service';
import { BaseConfigService } from '../config/base-config.service';
import { ConversationsEnum } from '../post-management/constants/conversations.enum';
import { PublicationModesEnum } from '../post-management/constants/publication-modes.enum';
import { channelInternalId } from '../../shared/publication/telegram-link';
import { ParserMenuService } from '../parser/services/parser-menu.service';
import { ParserModerationService } from '../parser/services/parser-moderation.service';
import {
  UserYearStatistics,
  YearResultsPreview,
} from '../year-results/interfaces/year-statistics.interface';
import { YearResultsService } from '../year-results/services/year-results.service';
import { AdminMenusEnum } from './constants/bot-menus.enum';
import { MenuPresenter } from './menu-presenter';
import { YearResultsMenuText } from './year-results-menu-text';

export type ScheduleFilter = 'all' | 'user' | 'parser';

@Injectable()
export class AdminMenuService implements OnModuleInit {
  /** Чистые тексты админ-меню (итоги года, лимиты мемов). */
  private readonly menuText = new YearResultsMenuText();
  /** Общие хелперы сборки меню (ownerGuard, переходы). */
  private readonly menuPresenter = new MenuPresenter();

  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private userService: UserService,
    private baseConfigService: BaseConfigService,
    private clientBaseService: ClientBaseService,
    private postSchedulerService: PostSchedulerService,
    private yearResultsService: YearResultsService,
    private parserMenuService: ParserMenuService,
    private parserModeration: ParserModerationService
  ) {}

  /** Пропускает действие только для владельца; остальным пишет отказ. */
  private ownerGuard(handler: (ctx: BotContext & MenuFlavor) => Promise<void> | void) {
    return this.menuPresenter.ownerGuard(handler);
  }

  onModuleInit() {
    this.registerScheduleCallbacks();
    this.bot.errorBoundary(
      (err) => Logger.log(err),
      createConversation(
        this.addModeratorConversation.bind(this),
        ConversationsEnum.ADD_MODERATOR_CONVERSATION
      )
    );
  }

  public buildStartAdminMenu(
    userStartMenu: Menu<BotContext>,
    moderatorStartMenu: Menu<BotContext>
  ): Menu<BotContext> {
    const menu = new Menu<BotContext>(AdminMenusEnum.ADMIN_START_MENU)
      .text('👥 Модераторы', this.ownerGuard((ctx) => ctx.menu.nav('moderators-list')))
      .row()
      .text('➕ Добавить модератора', async (ctx) =>
        ctx.conversation.enter(ConversationsEnum.ADD_MODERATOR_CONVERSATION)
      )
      .row()
      .text('🤖 Боты и парсеры', this.ownerGuard((ctx) => ctx.menu.nav('admin-bots')))
      .row()
      .text('📅 Публикации и акции', this.ownerGuard((ctx) => ctx.menu.nav('admin-publications')))
      .row()
      .text('📊 Итоги года', this.ownerGuard((ctx) => ctx.menu.nav('admin-year-results')))
      .row()
      .text('Меню модератора', this.menuPresenter.switchToMenu(moderatorStartMenu))
      .row()
      .text('Меню пользователя', this.menuPresenter.switchToMenu(userStartMenu))
      .row();

    const botsMenu = new Menu<BotContext>('admin-bots')
      .text('🧭 Парсер мемов', this.ownerGuard((ctx) => ctx.menu.nav(AdminMenusEnum.PARSER_SETTINGS_MENU)))
      .row()
      .text(
        async () => {
          const status = await this.clientBaseService.lastObserverStatus();
          return status ? '👁 Юзербот: остановить' : '👁 Юзербот: запустить';
        },
        this.ownerGuard(async (ctx) => {
          await this.clientBaseService.toggleChannelObserver();
          ctx.menu.update();
        })
      )
      .row()
      .back('Назад');

    const publicationsMenu = new Menu<BotContext>('admin-publications')
      .text('🎚 Управление лимитом мемов', this.ownerGuard((ctx) => ctx.menu.nav('meme-limit-control')))
      .row()
      .text('📅 Сетка публикаций', this.ownerGuard(async (ctx) => this.showPublicationGrid(ctx)))
      .row()
      .text(
        '🏆 Лучший пост в «Лучшее»',
        this.ownerGuard(async (ctx) => {
          await this.clientBaseService.postDailyBestMeme(this.baseConfigService.bestMemeChanelId);
          await ctx.answerCallbackQuery('Лучший пост опубликован в «Лучшее»');
        })
      )
      .row()
      .text('📣 Промо бота', this.ownerGuard(async (ctx) => this.publishBotPromo(ctx)))
      .row()
      .back('Назад');

    const yearResultsMenu = new Menu<BotContext>('admin-year-results')
      .text('👀 Предпросмотр', this.ownerGuard(async (ctx) => this.showYearResults(ctx)))
      .row()
      .text('🚀 Опубликовать', this.ownerGuard(async (ctx) => this.publishYearResults(ctx)))
      .row()
      .back('Назад');

    const moderatorsListMenu = new Menu<BotContext>('moderators-list').dynamic(async () => {
      const moderators = await this.userService.getModerators();
      const range = new MenuRange<BotContext>();
      for (const moderator of moderators) {
        range
          .text('@' + moderator.username, (ctx) => {
            ctx.session.lastChangedModeratorId = moderator.id;
            ctx.menu.nav('moderator-manage');
          })
          .row();
      }
      if (moderators.length) {
        range.back('Назад');
      } else {
        range.text('Список пуст', (ctx) => ctx.menu.nav(AdminMenusEnum.ADMIN_START_MENU));
      }
      return range;
    });

    const moderatorSettingMenu = new Menu<BotContext>('moderator-manage')
      .text('Исключить из модераторов', async (ctx) => {
        await this.removeModerator(ctx);
        ctx.session.lastChangedModeratorId = undefined;
        ctx.menu.nav('moderators-list');
      })
      .row()
      .text(
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          return user.allowPublishToChannel ? 'Может публиковать' : 'Не может публиковать';
        },
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          await this.userService.repository.update(
            { id: ctx.session.lastChangedModeratorId },
            { allowPublishToChannel: !user.allowPublishToChannel }
          );
          ctx.menu.update();
        }
      )
      .row()
      .text(
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          return user.allowDeleteRejectedPost
            ? 'Может удалять отклоненные'
            : 'Не может удалять отклоненные';
        },
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          await this.userService.repository.update(
            { id: ctx.session.lastChangedModeratorId },
            { allowDeleteRejectedPost: !user.allowDeleteRejectedPost }
          );
          ctx.menu.update();
        }
      )
      .row()
      .text(
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          return user.allowRestoreDiscardedPost
            ? 'Может возвращать отклоненные'
            : 'Не может возвращать отклоненные';
        },
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          await this.userService.repository.update(
            { id: ctx.session.lastChangedModeratorId },
            { allowRestoreDiscardedPost: !user.allowRestoreDiscardedPost }
          );
          ctx.menu.update();
        }
      )
      .row()
      .text(
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          return user.allowSetStrike ? 'Может выдавать страйки' : 'Не может выдавать страйки';
        },
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          await this.userService.repository.update(
            { id: ctx.session.lastChangedModeratorId },
            { allowSetStrike: !user.allowSetStrike }
          );
          ctx.menu.update();
        }
      )
      .row()
      .text(
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          return user.allowMakeBan ? 'Может банить' : 'Не может банить';
        },
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          await this.userService.repository.update(
            { id: ctx.session.lastChangedModeratorId },
            { allowMakeBan: !user.allowMakeBan }
          );
          ctx.menu.update();
        }
      )
      .row()
      .text('Назад', (ctx) => ctx.menu.nav('moderators-list'));

    const memeLimitControlMenu = new Menu<BotContext>('meme-limit-control')
      .text('Выбери пользователя', async (ctx) => {
        ctx.session.memeLimitControlState = 'select-user';
        ctx.menu.nav('meme-limit-select-user');
      })
      .row()
      .back('Назад');

    const memeLimitSelectUserMenu = new Menu<BotContext>('meme-limit-select-user').dynamic(
      async () => {
        const users = await this.userService.repository.find({
          where: { isBanned: false },
          order: { lastActivity: 'DESC' },
          take: 50,
        });

        const range = new MenuRange<BotContext>();
        for (const user of users) {
          range
            .text(`@${user.username}`, (ctx) => {
              ctx.session.memeLimitUserId = user.id;
              ctx.menu.nav('meme-limit-options');
            })
            .row();
        }
        range.back('Назад');
        return range;
      }
    );

    const memeLimitOptionsMenu = new Menu<BotContext>('meme-limit-options')
      .text(this.menuText.limitButtonLabel(24), async (ctx) => {
        await this.userService.disableMemeLimitForUser(ctx.session.memeLimitUserId, 24);
        await ctx.reply(this.menuText.limitRemovedMessage(24));
        ctx.menu.nav(AdminMenusEnum.ADMIN_START_MENU);
      })
      .row()
      .text(this.menuText.limitButtonLabel(1), async (ctx) => {
        await this.userService.disableMemeLimitForUser(ctx.session.memeLimitUserId, 1);
        await ctx.reply(this.menuText.limitRemovedMessage(1));
        ctx.menu.nav(AdminMenusEnum.ADMIN_START_MENU);
      })
      .row()
      .back('Назад');

    menu.register(moderatorsListMenu);
    menu.register(moderatorSettingMenu);
    menu.register(memeLimitControlMenu);
    menu.register(memeLimitSelectUserMenu);
    menu.register(memeLimitOptionsMenu);
    menu.register(this.parserMenuService.getMenu());
    menu.register(botsMenu);
    menu.register(publicationsMenu);
    menu.register(yearResultsMenu);

    return menu;
  }

  public async addModeratorConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    let user: UserEntity = null;

    await ctx.reply('Пришли имя пользователя которого хочешь добавить в модераторы', {
      reply_markup: { force_reply: true, input_field_placeholder: 'username' },
    });
    while (!user) {
      const messageCtx = await conversation.wait();

      if (!messageCtx.message.text) {
        continue;
      }

      user = await conversation.external(() =>
        this.userService.repository.findOne({ where: { username: messageCtx.message?.text } })
      );

      let text = 'Не нашли такого пользователя';
      if (user?.isModerator) {
        text = 'Этот пользователь уже модератор';
        user = null;
      }

      if (user?.isBanned) {
        text = 'Этот пользователь заблокирован';
        user = null;
      }
      if (messageCtx.message?.text === '/cancel') {
        await ctx.reply('Закончили искать модератора');
        return;
      }

      if (!user) {
        await ctx.reply(text + '\nесли ты передумал, то нажми /cancel');
      }
    }

    const link = await ctx.api.createChatInviteLink(this.baseConfigService.userRequestMemeChannel, {
      member_limit: 1,
      name: `moderator: ${user.username}`,
      expire_date: getUnixTime(add(new Date(), { weeks: 1 })),
    });

    await this.userService.repository.update({ id: user.id }, { isModerator: true });

    const channelInfo = await ctx.api.getChat(this.baseConfigService.memeChanelId);

    const text =
      'Поздравляю! 🎉🎉🎉\nТебя назначили модератором канала ' +
      channelInfo['title'] +
      `\nТебе нужно присоединится к каналу в котором осуществляется модерация контента от пользователей\n\n` +
      link.invite_link +
      '\n\nЭто одноразовая ссылка и предназначена только для тебя 😉\n' +
      'Не делись этой ссылкой ни с кем';

    await ctx.api.sendMessage(user.id, text);
  }

  private async removeModerator(ctx: BotContext) {
    const moderatorId = ctx.session.lastChangedModeratorId;

    await this.userService.repository.update({ id: moderatorId }, { isModerator: false });
    await ctx.api.banChatMember(this.baseConfigService.userRequestMemeChannel, moderatorId);
    await ctx.api.sendMessage(
      moderatorId,
      'Жаль, но ты исключен из списка модераторов, доступ в канал предложки ограничен, но ты по прежнему можешь присылать посты'
    );
  }

  private async publishBotPromo(ctx: BotContext) {
    const inlineKeyboard = new InlineKeyboard().url(
      'Прислать пост',
      `https://t.me/${ctx.me.username}`
    );
    await this.bot.api.sendMessage(
      this.baseConfigService.memeChanelId,
      'Ты можешь прислать посты через бота 😉',
      { reply_markup: inlineKeyboard, disable_notification: true }
    );
  }

  /** Callback-и пагинированной сетки публикаций и снятия с публикации. */
  private registerScheduleCallbacks(): void {
    this.bot.callbackQuery(/^sched:p:(all|user|parser):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      await ctx.answerCallbackQuery();
      await this.sendSchedulePage(ctx, Number(ctx.match?.[2]), false, ctx.match?.[1] as ScheduleFilter);
    });

    this.bot.callbackQuery(/^sched:off:(all|user|parser):(\d+):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      await ctx.answerCallbackQuery('Снять с публикации?');
      const filter = ctx.match?.[1] as ScheduleFilter;
      const page = ctx.match?.[2];
      const id = ctx.match?.[3];
      await this.editScheduleKeyboard(
        ctx,
        new InlineKeyboard()
          .text('✅ Снять с публикации', `sched:offok:${filter}:${page}:${id}`)
          .text('↩️ Отмена', `sched:offno:${filter}:${page}:${id}`)
      );
    });

    this.bot.callbackQuery(/^sched:offno:(all|user|parser):(\d+):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      await ctx.answerCallbackQuery('Оставлено');
      await this.sendSchedulePage(ctx, Number(ctx.match?.[2]), false, ctx.match?.[1] as ScheduleFilter);
    });

    this.bot.callbackQuery(/^sched:offok:(all|user|parser):(\d+):(\d+)$/, async (ctx) => {
      if (!ctx.config?.isOwner) return ctx.answerCallbackQuery('Только владелец');
      try {
        const filter = ctx.match?.[1] as ScheduleFilter;
        const page = Number(ctx.match?.[2]);
        const id = Number(ctx.match?.[3]);
        const entry = await this.postSchedulerService.getScheduledPostById(id);
        const messageId = entry?.requestChannelMessageId
          ? Number(entry.requestChannelMessageId)
          : null;
        const removed = messageId
          ? await this.parserModeration.unscheduleByMessageId(messageId)
          : (await this.postSchedulerService.removeById(id)) > 0;
        await ctx.answerCallbackQuery(removed ? 'Снято с публикации' : 'Уже снято');
        await this.sendSchedulePage(ctx, page, false, filter);
        return;
      } catch (error) {
        Logger.warn(`Schedule remove failed: ${error}`);
      }
      await ctx.answerCallbackQuery('Ошибка снятия');
    });
  }

  /** Рисует страницу сетки: ближайшие публикации первыми, с фильтром по типу. */
  public async sendSchedulePage(
    ctx: BotContext,
    page: number,
    forceSend = false,
    filter: ScheduleFilter = 'all'
  ): Promise<void> {
    const PAGE = 8;
    const isUserPost = filter === 'all' ? undefined : filter === 'user';
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
    const total =
      isUserPost === undefined
        ? await this.postSchedulerService.countUpcoming()
        : await this.postSchedulerService.countUpcoming(isUserPost);
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const current = Math.min(safePage, pages - 1);
    const rows =
      isUserPost === undefined
        ? await this.postSchedulerService.getUpcomingPage(PAGE, current * PAGE)
        : await this.postSchedulerService.getUpcomingPage(PAGE, current * PAGE, isUserPost);

    const labels: Record<ScheduleFilter, string> = {
      all: 'все',
      user: '👤 юзерские',
      parser: '🧭 парсер',
    };
    const channelId = channelInternalId(this.baseConfigService.userRequestMemeChannel);
    const lines = [
      `📅 <b>Сетка публикаций</b> · ${labels[filter]} · стр. ${current + 1}/${pages} · всего ${total}`,
    ];
    if (!rows.length) {
      lines.push('— пусто —');
    } else {
      rows.forEach((row, index) => {
        const date = utcToZonedTime(row.publishDate, 'Europe/Moscow');
        const when = format(date, 'dd.MM HH:mm');
        const link = `https://t.me/c/${channelId}/${row.requestChannelMessageId}`;
        const who = row.processedByModerator?.username ? ` · @${row.processedByModerator.username}` : '';
        const kind = row.isUserPost ? '👤' : '🧭';
        lines.push(`${current * PAGE + index + 1}. ${when} ${kind} · <a href="${link}">карточка</a>${who}`);
      });
    }

    type GridBtn = { text: string; callback_data: string; style?: 'danger' | 'success' | 'primary' };
    const matrix: Array<GridBtn[]> = [
      [
        { text: filter === 'all' ? '• Все' : 'Все', callback_data: `sched:p:all:0`, style: filter === 'all' ? 'primary' : undefined },
        { text: filter === 'user' ? '• 👤 Юзер' : '👤 Юзер', callback_data: `sched:p:user:0`, style: filter === 'user' ? 'primary' : undefined },
        { text: filter === 'parser' ? '• 🧭 Парсер' : '🧭 Парсер', callback_data: `sched:p:parser:0`, style: filter === 'parser' ? 'primary' : undefined },
      ],
    ];
    let rowButtons: GridBtn[] = [];
    rows.forEach((row) => {
      const date = utcToZonedTime(row.publishDate, 'Europe/Moscow');
      rowButtons.push({
        text: `🚫 Снять ${format(date, 'dd.MM HH:mm')}`,
        callback_data: `sched:off:${filter}:${current}:${row.id}`,
        style: 'danger',
      });
      if (rowButtons.length === 2) {
        matrix.push(rowButtons);
        rowButtons = [];
      }
    });
    if (rowButtons.length) matrix.push(rowButtons);
    const nav: GridBtn[] = [];
    if (current > 0) nav.push({ text: '⬅️', callback_data: `sched:p:${filter}:${current - 1}` });
    if (current < pages - 1)
      nav.push({ text: '➡️', callback_data: `sched:p:${filter}:${current + 1}` });
    if (nav.length) matrix.push(nav);
    const keyboard = InlineKeyboard.from(matrix);

    await this.sendScheduleMessage(ctx, lines.join('\n'), keyboard, forceSend);
  }

  private async sendScheduleMessage(
    ctx: BotContext,
    text: string,
    keyboard: InlineKeyboard,
    forceSend = false
  ): Promise<void> {
    try {
      if (ctx.callbackQuery && !forceSend) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      }
      await this.bot.api.sendMessage(ctx.from?.id ?? this.baseConfigService.ownerId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (error) {
      Logger.warn(`Schedule grid render failed: ${error}`);
    }
  }

  private async editScheduleKeyboard(ctx: BotContext, keyboard: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    } catch (error) {
      Logger.warn(`Schedule grid keyboard failed: ${error}`);
    }
  }

  private async showPublicationGrid(ctx: BotContext): Promise<void> {
    await this.sendSchedulePage(ctx, 0, true);
  }

  public getPostMessagesGrid(
    header: string,
    mode: PublicationModesEnum,
    mappedPosts: { [key: string]: PostSchedulerEntity[] }
  ): string {
    const posts = mappedPosts[mode];
    const interval = SchedulerCommonService.timeIntervalByMode(mode);

    // чтобы ссылка работала
    const channelLinkId = channelInternalId(this.baseConfigService.userRequestMemeChannel);

    const nowTimeStamp = new Date();

    let message = '';
    message += `<b>${header}:</b>`;
    message += ` c ${format(set(nowTimeStamp, interval.from), 'HH:mm')}`;
    message += ` по ${format(set(nowTimeStamp, interval.to), 'HH:mm')}\n`;

    if (!posts?.length) {
      message += 'Постов нет\n\n';
      return message;
    }

    for (const post of posts) {
      if (post.isUserPost) {
        message += `👨`;
      }
      message += `- <a href="https://t.me/c/${channelLinkId}/${
        post.requestChannelMessageId
      }">${format(utcToZonedTime(post.publishDate, 'Europe/Moscow'), 'HH:mm')}</a>`;
      message += ` @${post.processedByModerator.username}`;

      message += '\n';
    }

    message += '\n';
    return message;
  }

  /**
   * Показывает предпросмотр итогов года
   */
  private async showYearResults(ctx: BotContext): Promise<void> {
    try {
      await ctx.reply(this.menuText.generating());

      const currentYear = new Date().getFullYear();
      const preview = await this.yearResultsService.generateYearResults(currentYear);

      // Отправляем общую статистику в том же формате, что будет опубликована
      const generalMessage = this.yearResultsService.formatGeneralStatistics(
        preview.general,
        preview.users
      );
      await ctx.reply(this.menuText.generalPreviewHeader() + generalMessage, {
        parse_mode: 'HTML',
      });

      // Показываем персональные сообщения пользователей
      if (preview.users.length > 0) {
        await ctx.reply(this.menuText.personalListHeader(preview.users.length), {
          parse_mode: 'HTML',
        });

        ctx.session.yearResultsPreview = preview;
        ctx.session.yearResultsCurrentUserIndex = 0;

        await this.sendUserDetailWithNavigation(ctx, preview, 0);
      }

      await ctx.reply(this.menuText.publishHint(), {
        parse_mode: 'HTML',
      });
    } catch (error) {
      Logger.error('Error showing year results:', error);
      await ctx.reply(this.menuText.generationError());
    }
  }

  /**
   * Отправляет детали пользователя с навигацией
   */
  private async sendUserDetailWithNavigation(
    ctx: BotContext,
    preview: YearResultsPreview,
    index: number
  ): Promise<void> {
    const user = preview.users[index];
    const year = preview.general.year;

    // Получаем все результаты для расчета процентиля
    const allResults = await this.yearResultsService['yearResultRepository'].find({
      where: { year },
      order: { totalPublished: 'DESC' },
    });

    // Вычисляем позицию пользователя в рейтинге
    const userPosition = allResults.findIndex((r) => r.userId === user.userId) + 1;
    const percentile = Math.round(
      ((allResults.length - userPosition + 1) / allResults.length) * 100
    );

    // Используем тот же метод форматирования, что и для отправки пользователям
    const message = this.yearResultsService['formatPersonalMessage'](
      user,
      year,
      percentile,
      allResults.length
    );

    const navigation = this.menuText.navigation(index, preview.users.length);
    const keyboard = new InlineKeyboard();

    if (navigation.previous) {
      keyboard.text(navigation.previous, `year_user_prev_${index}`);
    }

    keyboard.text(navigation.counter, 'year_user_count');

    if (navigation.next) {
      keyboard.text(navigation.next, `year_user_next_${index}`);
    }

    await ctx.reply(this.menuText.userPreviewText(user, message), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    // Регистрируем обработчики для навигации
    this.bot.callbackQuery(/year_user_prev_(\d+)/, async (ctx) => {
      const currentIndex = parseInt(ctx.match[1]);
      const newIndex = currentIndex - 1;
      await ctx.answerCallbackQuery();
      await this.sendUserDetailWithNavigation(ctx, ctx.session.yearResultsPreview, newIndex);
    });

    this.bot.callbackQuery(/year_user_next_(\d+)/, async (ctx) => {
      const currentIndex = parseInt(ctx.match[1]);
      const newIndex = currentIndex + 1;
      await ctx.answerCallbackQuery();
      await this.sendUserDetailWithNavigation(ctx, ctx.session.yearResultsPreview, newIndex);
    });

    this.bot.callbackQuery('year_user_count', async (ctx) => {
      await ctx.answerCallbackQuery();
    });
  }

  /**
   * Форматирует имя пользователя
   */
  private formatUserName(user: UserYearStatistics): string {
    return this.menuText.formatUserName(user);
  }

  /**
   * Публикует итоги года
   */
  private async publishYearResults(ctx: BotContext): Promise<void> {
    try {
      await ctx.reply(this.menuText.publishing());

      const currentYear = new Date().getFullYear();

      // Публикуем общую статистику в канал
      await this.yearResultsService.publishGeneralStatistics(currentYear);
      await ctx.reply(this.menuText.generalPublished());

      // Отправляем персональную статистику пользователям
      await this.yearResultsService.publishPersonalStatistics(currentYear);
      await ctx.reply(this.menuText.personalPublished());

      await ctx.reply(this.menuText.published());
    } catch (error) {
      Logger.error('Error publishing year results:', error);
      await ctx.reply(this.menuText.publishError());
    }
  }
}
