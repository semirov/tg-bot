import {Inject, Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {BOT} from '../bot/providers/bot.provider';
import {Bot} from 'grammy';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {Menu, MenuRange} from '@grammyjs/menu';
import {AdminMenusEnum} from './constants/bot-menus.enum';
import {UserService} from '../bot/services/user.service';
import {BaseConfigService} from '../config/base-config.service';
import {Conversation, createConversation} from '@grammyjs/conversations';
import {ConversationsEnum} from '../conversations/constants/conversations.enum';
import {UserEntity} from '../bot/entities/user.entity';
import {add, getUnixTime} from 'date-fns';
import {ClientBaseService} from '../client/services/client-base.service';

@Injectable()
export class AdminMenuService implements OnModuleInit {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private userService: UserService,
    private baseConfigService: BaseConfigService,
    private clientBaseService: ClientBaseService
  ) {
  }

  onModuleInit() {
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
      .text('Модераторы', (ctx) => ctx.menu.nav('moderators-list'))
      .row()
      .text('Добавить модератора', async (ctx) =>
        ctx.conversation.enter(ConversationsEnum.ADD_MODERATOR_CONVERSATION)
      )
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
      .text('Показать статистику пользователя')
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
            {id: ctx.session.lastChangedModeratorId},
            {allowPublishToChannel: !user.allowPublishToChannel}
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
            {id: ctx.session.lastChangedModeratorId},
            {allowDeleteRejectedPost: !user.allowDeleteRejectedPost}
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
            {id: ctx.session.lastChangedModeratorId},
            {allowRestoreDiscardedPost: !user.allowRestoreDiscardedPost}
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
            {id: ctx.session.lastChangedModeratorId},
            {allowSetStrike: !user.allowSetStrike}
          );
          ctx.menu.update();
        }
      )
      .row()
      .text(
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          return user.allowMakeBan ? 'Может банить' : 'Не может банить'
        },
        async (ctx) => {
          const user = await this.userService.findById(ctx.session.lastChangedModeratorId);
          await this.userService.repository.update(
            {id: ctx.session.lastChangedModeratorId},
            {allowMakeBan: !user.allowMakeBan}
          );
          ctx.menu.update();
        }
      )
      .row()
      .text('Назад', (ctx) => ctx.menu.nav('moderators-list'));

    menu.register(moderatorsListMenu);
    menu.register(moderatorSettingMenu);

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
        this.userService.repository.findOne({where: {username: messageCtx.message?.text}})
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

      if (!user) {
        await ctx.reply(text + '\nесли ты передумал, то нажми /cancel');
      }
      if (ctx.message?.text === '/cancel') {
        await ctx.reply('Закончили искать модератора');
        return;
      }
    }

    const link = await ctx.api.createChatInviteLink(this.baseConfigService.userRequestMemeChannel, {
      member_limit: 1,
      name: `moderator: ${user.username}`,
      expire_date: getUnixTime(add(new Date(), {weeks: 1})),
    });

    await this.userService.repository.update({id: user.id}, {isModerator: true});

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

    await this.userService.repository.update({id: moderatorId}, {isModerator: false});
    await ctx.api.banChatMember(this.baseConfigService.userRequestMemeChannel, moderatorId);
    await ctx.api.sendMessage(
      moderatorId,
      'Жаль, но ты исключен из списка модераторов, доступ в канал предложки ограничен, но ты по прежнему можешь присылать мемы'
    );
  }
}
