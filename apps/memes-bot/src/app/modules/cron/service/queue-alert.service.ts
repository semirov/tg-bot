import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bot } from 'grammy';
import { format } from 'date-fns';
import { utcToZonedTime } from 'date-fns-tz';
import { BaseConfigService } from '../../config/base-config.service';
import { BOT } from '../../bot/providers/bot.provider';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { PostSchedulerService } from '../../bot/services/post-scheduler.service';
import { QueueAlertStateEntity } from '../entities/queue-alert-state.entity';

/** Уровень заполненности очереди публикации. */
export enum QueueAlertLevel {
  HEALTHY = 'healthy',
  THREE_DAYS = 'three_days',
  ONE_DAY = 'one_day',
  EMPTY = 'empty',
}

export interface QueueSnapshot {
  level: QueueAlertLevel;
  /** Сколько дней вперёд заполнена сетка (null — постов нет). */
  days: number | null;
  count: number;
  until: Date | null;
}

const STATE_ID = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESEND_MS = DAY_MS;
const WINDOW_FROM_HOUR = 9;
const WINDOW_TO_HOUR = 23;
const TIME_ZONE = 'Europe/Moscow';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluralPosts(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'пост';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'поста';
  return 'постов';
}

/**
 * Следит за очередью публикации (запланированные неопубликованные посты) и
 * предупреждает владельца в ЛС, когда она пустеет: остаётся ~3 дня, ~1 день
 * или постов нет совсем. Шлёт при смене уровня, но не чаще раза в сутки и
 * только днём (09:00–23:00 МСК). Состояние хранится в БД, чтобы не дублировать
 * уведомление после перезапуска.
 */
@Injectable()
export class QueueAlertService implements OnModuleInit {
  private readonly logger = new Logger(QueueAlertService.name);
  private lastLevel: QueueAlertLevel | null = null;
  private lastSentAt: Date | null = null;

  constructor(
    private readonly postSchedulerService: PostSchedulerService,
    @InjectRepository(QueueAlertStateEntity)
    private readonly repository: Repository<QueueAlertStateEntity>,
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const state = await this.repository.findOne({ where: { id: STATE_ID } });
      if (state) {
        this.lastLevel = state.level as QueueAlertLevel;
        this.lastSentAt = state.sentAt;
      }
    } catch (error) {
      this.logger.warn(`Не удалось прочитать состояние алерта очереди: ${errorMessage(error)}`);
    }
  }

  /** Оценивает, на сколько дней вперёд заполнена очередь публикации. */
  public async evaluate(now: Date = new Date()): Promise<QueueSnapshot> {
    const count = await this.postSchedulerService.countUpcoming();
    if (count === 0) {
      return { level: QueueAlertLevel.EMPTY, days: null, count, until: null };
    }
    const furthest = await this.postSchedulerService.getFurthestUpcoming();
    const until = furthest?.publishDate ?? null;
    const days = until ? Math.max(0, (until.getTime() - now.getTime()) / DAY_MS) : 0;
    const level =
      days <= 1
        ? QueueAlertLevel.ONE_DAY
        : days <= 3
          ? QueueAlertLevel.THREE_DAYS
          : QueueAlertLevel.HEALTHY;
    return { level, days, count, until };
  }

  /** Проверяет очередь и при необходимости шлёт владельцу уведомление. */
  public async check(now: Date = new Date()): Promise<void> {
    const snapshot = await this.evaluate(now);
    if (snapshot.level === QueueAlertLevel.HEALTHY) {
      if (this.lastLevel !== null) {
        await this.persistState(null, null);
      }
      return;
    }
    if (!this.isWithinWindow(now)) {
      return;
    }
    const sameLevel = this.lastLevel === snapshot.level;
    const recently = this.lastSentAt
      ? now.getTime() - this.lastSentAt.getTime() < RESEND_MS
      : false;
    if (sameLevel && recently) {
      return;
    }
    await this.notify(snapshot, now);
  }

  /** Днём (09:00–23:00 МСК) — можно слать, ночью — молчим. */
  public isWithinWindow(now: Date): boolean {
    const hour = utcToZonedTime(now, TIME_ZONE).getHours();
    return hour >= WINDOW_FROM_HOUR && hour < WINDOW_TO_HOUR;
  }

  public buildMessage(snapshot: QueueSnapshot): string {
    const posts = `${snapshot.count} ${pluralPosts(snapshot.count)}`;
    if (snapshot.level === QueueAlertLevel.EMPTY) {
      return `🚨 Очередь публикации пуста\nВ сетке нет неопубликованных постов — скоро каналу будет нечего публиковать.`;
    }
    const when = snapshot.until
      ? `последний пост запланирован на ${this.formatMsk(snapshot.until)} МСК`
      : 'свободных слотов почти не осталось';
    if (snapshot.level === QueueAlertLevel.ONE_DAY) {
      return `⚠️ Очереди публикации хватит примерно на 1 день\n${when} (в сетке ${posts}).\nПора закинуть ещё мемов.`;
    }
    return `📉 Очередь публикации тает: осталось ~3 дня\n${when} (в сетке ${posts}).`;
  }

  public formatMsk(date: Date): string {
    return format(utcToZonedTime(date, TIME_ZONE), 'dd.MM в HH:mm');
  }

  private async notify(snapshot: QueueSnapshot, now: Date): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.config.ownerId, this.buildMessage(snapshot));
      await this.persistState(snapshot.level, now);
      this.logger.log(`Алерт очереди отправлен владельцу: ${snapshot.level}`);
    } catch (error) {
      this.logger.warn(`Не удалось отправить алерт очереди: ${errorMessage(error)}`);
    }
  }

  private async persistState(level: QueueAlertLevel | null, sentAt: Date | null): Promise<void> {
    this.lastLevel = level;
    this.lastSentAt = sentAt;
    try {
      if (level === null || sentAt === null) {
        await this.repository.delete({ id: STATE_ID });
        return;
      }
      await this.repository.save({ id: STATE_ID, level, sentAt });
    } catch (error) {
      this.logger.warn(`Не удалось сохранить состояние алерта очереди: ${errorMessage(error)}`);
    }
  }
}
