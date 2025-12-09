import { Conversation, createConversation } from '@grammyjs/conversations';
import { Menu, MenuRange } from '@grammyjs/menu';
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
import { YearResultsService } from '../year-results/services/year-results.service';
import { AdminMenusEnum } from './constants/bot-menus.enum';

@Injectable()
export class AdminMenuService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private userService: UserService,
    private baseConfigService: BaseConfigService,
    private clientBaseService: ClientBaseService,
    private postSchedulerService: PostSchedulerService,
    private yearResultsService: YearResultsService
  ) {}

  onModuleInit() {
    this.bot.errorBoundary(
      (err) => Logger.log(err),
      createConversation(
        this.addModeratorConversation.bind(this),
        ConversationsEnum.ADD_MODERATOR_CONVERSATION
      )
    );

    // Регистрируем команды для итогов года
    this.bot.command('year_result', async (ctx) => {
      if (!ctx.from) return;
      const user = await this.userService.findById(ctx.from.id);

      if (!ctx.config.isOwner) {
        await ctx.reply('У вас нет прав для выполнения этой команды');
        return;
      }
      await this.showYearResults(ctx);
    });

    this.bot.command('year_result_publish', async (ctx) => {
      if (!ctx.from) return;
      const user = await this.userService.findById(ctx.from.id);
      if (!ctx.config.isOwner) {
        await ctx.reply('У вас нет прав для выполнения этой команды');
        return;
      }
      await this.publishYearResults(ctx);
    });
  }

  public buildStartAdminMenu(
    userStartMenu: Menu<BotContext>,
    moderatorStartMenu: Menu<BotContext>
  ): Menu<BotContext> {
    const menu = new Menu<BotContext>(AdminMenusEnum.ADMIN_START_MENU)
      .text('Модераторы', (ctx) => ctx.menu.nav('moderators-list'))
      .row()
      .text('Добавить модератора', async (ctx) =>
        ctx.conversation.enter(ConversationsEnum.ADD_MODERATOR_CONVERSATION)
      )
      .row()
      .text('Управление лимитом мемов', (ctx) => ctx.menu.nav('meme-limit-control'))
      .row()
      .text('Управление лимитом мемов', (ctx) => ctx.menu.nav('meme-limit-control'))
      .row()
      .text('Сетка публикаций', async (ctx) => this.showPublicationGrid(ctx))
      .row()
      .text(
        async () => {
          const status = await this.clientBaseService.lastObserverStatus();
          return status ? 'Остановить обсерваторию' : 'Запустить обсерваторию';
        },
        async (ctx) => {
          await this.clientBaseService.toggleChannelObserver();
          ctx.menu.update();
        }
      )
      .row()
      .text('Опубликовать промо бота', async (ctx) => {
        await this.publishBotPromo(ctx);
      })
      .row()
      .text('Лучший пост в канал', async (ctx) => {
        await this.clientBaseService.postDailyBestMeme(ctx.from.id);
      })
      .row()
      .text('Меню модератора', (ctx) =>
        ctx.reply('Выбери то, что хочешь сделать', {
          reply_markup: moderatorStartMenu,
        })
      )
      .row()
      .text('Меню пользователя', (ctx) =>
        ctx.reply('Выбери то, что хочешь сделать', {
          reply_markup: userStartMenu,
        })
      )
      .row();

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
      .text('Снять лимит на 24 часа', async (ctx) => {
        await this.userService.disableMemeLimitForUser(ctx.session.memeLimitUserId, 24);
        await ctx.reply(`Лимит мемов снят для пользователя на 24 часа`);
        ctx.menu.nav(AdminMenusEnum.ADMIN_START_MENU);
      })
      .row()
      .text('Снять лимит на 1 час', async (ctx) => {
        await this.userService.disableMemeLimitForUser(ctx.session.memeLimitUserId, 1);
        await ctx.reply(`Лимит мемов снят для пользователя на 1 час`);
        ctx.menu.nav(AdminMenusEnum.ADMIN_START_MENU);
      })
      .row()
      .back('Назад');

    menu.register(moderatorsListMenu);
    menu.register(moderatorSettingMenu);
    menu.register(memeLimitControlMenu);
    menu.register(memeLimitSelectUserMenu);
    menu.register(memeLimitOptionsMenu);

    return menu;
  }

  public async addModeratorConversation(
    conversation: Conversation<BotContext>,
    ctx: BotContext
  ): Promise<void> {
    let user: UserEntity = null;

    await ctx.reply('Пришли имя пользователя которого хочешь добавить в модераторы');
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

  private async showPublicationGrid(ctx: BotContext): Promise<void> {
    const scheduledPost = await this.postSchedulerService.getScheduledPost();
    let message = '';
    const mapped = scheduledPost.reduce((acc, post) => {
      if (!acc[post.mode]?.length) {
        acc[post.mode] = [];
      }
      acc[post.mode].push(post);
      return acc;
    }, {});
    message += '<b>Сетка публикаций</b>\n\n';
    message += this.getPostMessagesGrid('Кринж', PublicationModesEnum.NIGHT_CRINGE, mapped);
    message += this.getPostMessagesGrid('Ночь', PublicationModesEnum.NEXT_NIGHT, mapped);
    message += this.getPostMessagesGrid('Утро', PublicationModesEnum.NEXT_MORNING, mapped);
    message += this.getPostMessagesGrid('День', PublicationModesEnum.NEXT_MIDDAY, mapped);
    message += this.getPostMessagesGrid('Вечер', PublicationModesEnum.NEXT_EVENING, mapped);

    await ctx.api.sendMessage(ctx.callbackQuery.from.id, message, { parse_mode: 'HTML' });
    return;
  }

  public getPostMessagesGrid(
    header: string,
    mode: PublicationModesEnum,
    mappedPosts: { [key: string]: PostSchedulerEntity[] }
  ): string {
    const posts = mappedPosts[mode];
    const interval = SchedulerCommonService.timeIntervalByMode(mode);

    // чтобы ссылка работала
    const channelLinkId = this.baseConfigService.userRequestMemeChannel * -1 - 1000000000000;

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
      await ctx.reply('Генерирую итоги года...');

      const currentYear = new Date().getFullYear();
      const preview = await this.yearResultsService.generateYearResults(currentYear);

      // Отправляем общую статистику в том же формате, что будет опубликована
      const generalMessage = this.yearResultsService.formatGeneralStatistics(
        preview.general,
        preview.users
      );
      await ctx.reply('<b>📊 Предпросмотр общей статистики для канала:</b>\n\n' + generalMessage, {
        parse_mode: 'HTML',
      });

      // Показываем персональные сообщения пользователей
      if (preview.users.length > 0) {
        await ctx.reply(
          `<b>📨 Персональные сообщения (${preview.users.length}):</b>\n\nИспользуйте кнопки для навигации`,
          { parse_mode: 'HTML' }
        );

        ctx.session.yearResultsPreview = preview;
        ctx.session.yearResultsCurrentUserIndex = 0;

        await this.sendUserDetailWithNavigation(ctx, preview, 0);
      }

      await ctx.reply('Для публикации итогов используйте команду /year_result_publish', {
        parse_mode: 'HTML',
      });
    } catch (error) {
      Logger.error('Error showing year results:', error);
      await ctx.reply('Произошла ошибка при генерации итогов года');
    }
  }

  /**
   * Отправляет детали пользователя с навигацией
   */
  private async sendUserDetailWithNavigation(
    ctx: BotContext,
    preview: any,
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

    const keyboard = new InlineKeyboard();

    if (index > 0) {
      keyboard.text('⬅️ Предыдущий', `year_user_prev_${index}`);
    }

    keyboard.text(`${index + 1}/${preview.users.length}`, 'year_user_count');

    if (index < preview.users.length - 1) {
      keyboard.text('Следующий ➡️', `year_user_next_${index}`);
    }

    await ctx.reply(
      `<b>📨 Предпросмотр сообщения для ${this.formatUserName(user)}:</b>\n\n${message}`,
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }
    );

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
  private formatUserName(user: any): string {
    if (user.username) {
      return `@${user.username}`;
    }
    return [user.firstName, user.lastName].filter((item) => !!item).join(' ');
  }

  /**
   * Публикует итоги года
   */
  private async publishYearResults(ctx: BotContext): Promise<void> {
    try {
      await ctx.reply('Публикую итоги года...');

      const currentYear = new Date().getFullYear();

      // Публикуем общую статистику в канал
      await this.yearResultsService.publishGeneralStatistics(currentYear);
      await ctx.reply('✅ Общая статистика опубликована в канал');

      // Отправляем персональную статистику пользователям
      await this.yearResultsService.publishPersonalStatistics(currentYear);
      await ctx.reply('✅ Персональная статистика отправлена пользователям');

      await ctx.reply('🎉 Итоги года успешно опубликованы!');
    } catch (error) {
      Logger.error('Error publishing year results:', error);
      await ctx.reply('Произошла ошибка при публикации итогов года');
    }
  }
}
