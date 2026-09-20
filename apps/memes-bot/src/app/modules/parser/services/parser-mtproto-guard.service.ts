import { Inject, Injectable, Logger } from '@nestjs/common';
import { BOT } from '../../bot/providers/bot.provider';
import { Bot } from 'grammy';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import { BaseConfigService } from '../../config/base-config.service';
import { RANDOM, Random } from '../../../shared/random';
import {
  FLOOD_CUMULATIVE_CAP_SEC,
  FLOOD_DEADLINE_MS,
  FLOOD_MAX_ATTEMPTS,
  FLOOD_SINGLE_CAP_SEC,
} from '../constants/parser.constants';

/** Терминальные ошибки MTProto: ретраить бессмысленно, аккаунт в опасности. */
export class TerminalMtprotoError extends Error {
  constructor(public readonly code: string) {
    super(`Terminal MTProto error: ${code}`);
  }
}

const isFloodWait = (error: unknown): number | null => {
  const raw = String((error as { errorMessage?: string; message?: string })?.errorMessage ??
    (error instanceof Error ? error.message : error) ?? '');
  const match = raw.match(/FLOOD(?:_PREMIUM)?_WAIT_(\d+)/);
  return match ? Number(match[1]) : null;
};

const terminalCode = (error: unknown): string | null => {
  const raw = String((error as { errorMessage?: string })?.errorMessage ??
    (error instanceof Error ? error.message : error) ?? '');
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/.test(raw)) return 'AUTH_KEY_UNREGISTERED';
  if (/USER_DEACTIVATED(_BAN)?/.test(raw)) return 'USER_DEACTIVATED_BAN';
  return null;
};

/**
 * Обёртка MTProto-вызовов парсера: FloodWait-конверт (cap, дедлайн,
 * кумулятивный бюджет, попытки), jitter-паузы и stop-and-alert для
 * терминальных ошибок аккаунта.
 */
@Injectable()
export class ParserMtprotoGuard {
  private readonly logger = new Logger(ParserMtprotoGuard.name);
  private alerted = false;

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService,
    @Inject(RANDOM) private readonly random: Random
  ) {}

  /**
   * Выполняет MTProto-операцию с защитой от флуда.
   * Возвращает undefined, если операция не удалась (кроме терминальных —
   * они пробрасываются после алерта).
   */
  async run<T>(operation: string, fn: () => Promise<T>): Promise<T | undefined> {
    const startedAt = Date.now();
    let cumulativeSleepSec = 0;

    for (let attempt = 1; attempt <= FLOOD_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        const terminal = terminalCode(error);
        if (terminal) {
          await this.alertOwner(terminal);
          throw new TerminalMtprotoError(terminal);
        }

        const floodSec = isFloodWait(error);
        if (floodSec === null) {
          this.logger.warn(`Parser MTProto ${operation} failed: ${describe(error)}`);
          return undefined;
        }

        if (
          attempt === FLOOD_MAX_ATTEMPTS ||
          Date.now() - startedAt > FLOOD_DEADLINE_MS ||
          cumulativeSleepSec + floodSec > FLOOD_CUMULATIVE_CAP_SEC
        ) {
          this.logger.warn(
            `Parser MTProto ${operation}: flood budget exhausted (wait=${floodSec}s, cumulative=${cumulativeSleepSec}s)`
          );
          return undefined;
        }

        const sleepSec = Math.min(FLOOD_SINGLE_CAP_SEC, floodSec) + 1;
        cumulativeSleepSec += sleepSec;
        this.logger.warn(
          `Parser MTProto ${operation}: FLOOD_WAIT ${floodSec}s, sleeping ${sleepSec}s (attempt ${attempt}/${FLOOD_MAX_ATTEMPTS})`
        );
        await this.sleep(sleepSec * 1000);
      }
    }

    return undefined;
  }

  /** Пауза с jitterом между MTProto-вызовами (анти-«поезд»). */
  async pace(baseMs: number, jitterMs = 500): Promise<void> {
    const jitter = Math.floor(this.random.next() * jitterMs);
    await this.sleep(baseMs + jitter);
  }

  private async alertOwner(code: string): Promise<void> {
    if (this.alerted) return;
    this.alerted = true;
    this.logger.error(`Parser: terminal MTProto error ${code} — конвейер остановлен`);
    try {
      await this.bot.api.sendMessage(
        this.config.ownerId,
        `⛔️ Парсер остановлен: терминальная ошибка MTProto (${code}). Проверь аккаунт-парсер.`
      );
    } catch (error) {
      this.logger.error(`Parser: cannot alert owner: ${error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
