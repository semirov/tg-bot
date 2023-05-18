import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UserRequestEntity } from '../entities/user-request.entity';
import { MoreThan, Repository } from 'typeorm';
import { BotContext } from '../interfaces/bot-context.interface';
import { intervalToDuration, sub } from 'date-fns';
import * as ruPlural from 'plural-ru';

@Injectable()
export class UserRequestService {
  constructor(
    @InjectRepository(UserRequestEntity)
    private userRequestRepository: Repository<UserRequestEntity>
  ) {}

  public get repository(): Repository<UserRequestEntity> {
    return this.userRequestRepository;
  }

  public async lastPublishedPostTimeAgo(ctx: BotContext): Promise<string> {
    const message = await this.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    const lastPublishedMessage = await this.repository.findOne({
      where: {
        user: { id: message.user.id },
        isPublished: true,
      },
      order: { publishedAt: 'DESC' },
    });

    if (!lastPublishedMessage) {
      return 'нет';
    }

    const duration = intervalToDuration({
      start: lastPublishedMessage.publishedAt,
      end: new Date(),
    });

    switch (true) {
      case !!duration?.years:
        return ruPlural.noun(duration.years, '%d год', '%d года', '%d лет');
      case !!duration?.months:
        return ruPlural.noun(duration.months, '%d месяц', '%d месяца', '%d месяцев');
      case !!duration?.weeks:
        return ruPlural.noun(duration.weeks, '%d неделя', '%d недели', '%d недель');
      case !!duration?.days:
        return ruPlural.noun(duration.days, '%d день', '%d дня', '%d дней');
      case !!duration?.hours:
        return ruPlural.noun(duration.hours, '%d час', '%d часа', '%d часов');
      case !!duration?.minutes:
        return ruPlural.noun(duration.minutes, '%d минута', '%d минуты', '%d минут');
      case !!duration?.seconds:
        return 'Только что';
    }
  }

  public async userPostApprovedStatistic(ctx: BotContext): Promise<{ total: number; day: number }> {
    const message = await this.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    const [total, day] = await Promise.all([
      this.repository.countBy({
        user: { id: message.user.id },
        isPublished: true,
      }),
      this.repository.countBy({
        user: { id: message.user.id },
        isPublished: true,
        publishedAt: MoreThan<Date>(sub(new Date(Date.now()), { days: 1 })),
      }),
    ]);

    return { total: total || 0, day: day || 0 };
  }

  public async userPostDiscardStatistic(ctx: BotContext): Promise<{ total: number; week: number }> {
    const message = await this.repository.findOne({
      where: { userRequestChannelMessageId: ctx.callbackQuery.message.message_id },
      relations: { user: true },
    });

    const [total, week] = await Promise.all([
      this.repository.countBy({
        user: { id: message.user.id },
        isApproved: false,
      }),
      this.repository.countBy({
        user: { id: message.user.id },
        isApproved: false,
        moderatedAt: MoreThan<Date>(sub(new Date(Date.now()), { days: 1 })),
      }),
    ]);

    return { total: total || 0, week: week || 0 };
  }
}
