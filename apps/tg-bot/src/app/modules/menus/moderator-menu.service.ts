import {Inject, Injectable} from '@nestjs/common';
import {BOT} from '../bot/providers/bot.provider';
import {Bot} from 'grammy';
import {BotContext} from '../bot/interfaces/bot-context.interface';
import {Menu} from '@grammyjs/menu';
import {AdminMenusEnum, ModeratorMenusEnum} from './constants/bot-menus.enum';
import {UserRequestService} from '../bot/services/user-request.service';
import {MoreThan} from 'typeorm';
import {sub} from 'date-fns';

@Injectable()
export class ModeratorMenuService {
  constructor(
    @Inject(BOT) private bot: Bot<BotContext>,
    private userRequestService: UserRequestService
  ) {
  }

  public buildStartModeratorMenu(userStartMenu: Menu<BotContext>): Menu<BotContext> {
    return new Menu<BotContext>(ModeratorMenusEnum.MODERATOR_START_MENU)
      .text('Меню пользователя', (ctx) =>
        ctx.reply('Выбери то, что хочешь сделать', {
          reply_markup: userStartMenu,
        })
      )
      .row()
      .text('Показать статистику', async (ctx) => this.showModeratorStatistic(ctx))
      .row();
  }

  private async showModeratorStatistic(ctx: BotContext) {
    const userId = ctx.config.user.id;

    const [
      totalApproved,
      monthsApproved,
      weekApproved,
      dayApproved,
      totalDescarded,
      monthsDiscarded,
      weekDiscarded,
      dayDiscarded,
    ] = await Promise.all([
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: true,
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: true,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), {months: 1})),
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: true,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), {weeks: 1})),
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: true,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), {days: 1})),
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: false,
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: false,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), {months: 1})),
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: false,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), {weeks: 1})),
      }),
      this.userRequestService.repository.countBy({
        processedByModerator: {id: userId},
        isApproved: false,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), {days: 1})),
      }),
    ]);

    const message =
      `<b>Одобрено постов:</b>\n` +
      `всего: ${totalApproved}\n` +
      `за месяц: ${monthsApproved}\n` +
      `за неделю: ${weekApproved}\n` +
      `за день: ${dayApproved}\n\n` +
      `<b>Отклонено постов</b>:\n` +
      `всего: ${totalDescarded}\n` +
      `за месяц: ${monthsDiscarded}\n` +
      `за неделю: ${weekDiscarded}\n` +
      `за день: ${dayDiscarded}`;

    ctx.reply(message, {parse_mode: 'HTML'});
  }
}
