import { Inject, Injectable } from '@nestjs/common';
import { UserRequestService } from '../../bot/services/user-request.service';
import { BOT } from '../../bot/providers/bot.provider';
import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { sub } from 'date-fns';
import { BaseConfigService } from '../../config/base-config.service';

export type StatisticRequestType = {
  isAnonymousPublishing: boolean;
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  count: string;
};

@Injectable()
export class MonthlyStatService {
  constructor(
    private userRequestService: UserRequestService,
    @Inject(BOT) private bot: Bot<BotContext>,
    private baseConfigService: BaseConfigService
  ) {}

  private getNameFromStatItem(item: StatisticRequestType): string {
    if (item.username) {
      return `@${item.username}`;
    }

    return [item.firstName, item.lastName].filter((item) => !!item).join(' ');
  }

  private leaderBoardIconByIndex(index: string): string {
    const icons = {
      '0': '🏅',
      '1': '🥈',
      '2': '🥉',
    };

    const icon = icons[index];
    if (icon) {
      return `${icon} `;
    }
    return ``;
  }

  public async publishMonthlyStatistic(): Promise<void> {
    const statistics = await this.getUserStatistic();

    let text =
      'Каждый месяц публикуется список наиболее активных пользователей предложки\n' +
      'спасибо вам за посты ❤️\n\n';
    for (const index in statistics) {
      const item = statistics[index];
      text += `${this.leaderBoardIconByIndex(index)}${this.getNameFromStatItem(item)} - ${
        item.count
      }\n\n`;
    }

    text += 'Чтобы попасть в этот список нужно предлагать посты через бота 😉\n';
    text += '#статистика';

    const me = await this.bot.api.getMe();

    const inlineKeyboard = new InlineKeyboard().url('Прислать пост', `https://t.me/${me.username}`);

    const message = await this.bot.api.sendMessage(this.baseConfigService.memeChanelId, text, {
      reply_markup: inlineKeyboard,
    });

    this.sendPersonalStatistic(statistics, message.message_id);
  }

  private async getUserStatistic(): Promise<StatisticRequestType[]> {
    const queryBuilder = this.userRequestService.repository.createQueryBuilder('userRequest');
    return await queryBuilder
      .leftJoinAndSelect('userRequest.user', 'user')
      .select('user.id', 'userId')
      .addSelect('user.username', 'username')
      .addSelect('user.firstName', 'firstName')
      .addSelect('user.lastName', 'lastName')
      .addSelect('COUNT(userRequest.id)', 'count')
      .where('userRequest.isPublished = true')
      .andWhere('userRequest.publishedAt >= :date', { date: sub(new Date(), { months: 1 }) })
      .groupBy('user.id')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();
  }

  private async sendPersonalStatistic(
    statistics: StatisticRequestType[],
    statisticMessageId: number
  ): Promise<void> {
    for (const index in statistics) {
      const item = statistics[index];
      let text = `Привет!\n\nТы в топе пользователей предложки 🎉🎉\n\n`;
      text += `За последний месяц было опубликовано постов - ${item.count}\n`;
      text += `Твое место в общем рейтинге - ${Number(index) + 1}\n\n`;
      text += `Спасибо что предлагаешь посты ❤️`;

      const userId = item.userId;
      try {
        await this.bot.api.sendMessage(userId, text);
        await this.bot.api.forwardMessage(
          +userId,
          this.baseConfigService.memeChanelId,
          statisticMessageId
        );
      } catch (e) {
        console.error('[Error while sent personal statistic]', e);
      }
    }
  }
}
