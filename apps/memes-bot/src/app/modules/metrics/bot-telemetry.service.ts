import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Bot, Transformer } from 'grammy';

import { metrics } from '../../shared/metrics';
import { BotContext } from '../bot/interfaces/bot-context.interface';
import { BOT } from '../bot/providers/bot.provider';

/** Короткое имя типа обновления для метки (без кардинальных id). */
export function telegramUpdateType(update: Record<string, unknown> | undefined): string {
  if (!update) {
    return 'unknown';
  }
  const known = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'callback_query',
    'inline_query',
    'chat_join_request',
    'chat_member',
    'my_chat_member',
    'poll_answer',
    'pre_checkout_query',
  ];
  const found = known.find((key) => update[key] !== undefined);
  return found ?? 'other';
}

/**
 * Телеметрия транспорта: считает обновления Telegram и все вызовы Bot API
 * (метод, исход, длительность). Ставится в bootstrap через Nest lifecycle,
 * поэтому не требует правок в бизнес-сервисах.
 */
@Injectable()
export class BotTelemetryService implements OnModuleInit {
  constructor(@Inject(BOT) private readonly bot: Bot<BotContext>) {}

  public onModuleInit(): void {
    this.instrumentUpdates();
    this.instrumentApiCalls();
  }

  /** Считает апдейты и ошибки их обработки по цепочке middleware. */
  public instrumentUpdates(): void {
    this.bot.use(async (ctx, next) => {
      const type = telegramUpdateType(ctx.update as unknown as Record<string, unknown>);
      metrics.updates.total.inc({ type });
      try {
        await next();
      } catch (error) {
        metrics.updates.errors.inc({ type });
        throw error;
      }
    });
  }

  /** Оборачивает все исходящие вызовы Bot API таймером и счётчиком исхода. */
  public instrumentApiCalls(): void {
    const transformer: Transformer = async (prev, method, payload, signal) => {
      const stopTimer = metrics.telegramApi.duration.startTimer({ method: String(method) });
      try {
        const result = await prev(method, payload, signal);
        metrics.telegramApi.requests.inc({ method: String(method), result: 'ok' });
        return result;
      } catch (error) {
        metrics.telegramApi.requests.inc({ method: String(method), result: 'error' });
        throw error;
      } finally {
        stopTimer();
      }
    };

    this.bot.api.config.use(transformer);
  }
}
