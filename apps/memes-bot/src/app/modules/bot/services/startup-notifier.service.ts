import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Bot } from 'grammy';
import { BaseConfigService } from '../../config/base-config.service';
import { APP_VERSION } from '../../../version';
import { BotContext } from '../interfaces/bot-context.interface';
import { BOT } from '../providers/bot.provider';

/**
 * Отправляет владельцу уведомление о запуске бота с версией сборки.
 *
 * Срабатывает на `OnApplicationBootstrap` — уже после того, как все модули
 * инициализированы, поэтому владелец получает сообщение только когда бот реально
 * готов к работе. Ошибка отправки не должна ронять старт приложения: она лишь
 * логируется.
 */
@Injectable()
export class StartupNotifierService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupNotifierService.name);

  constructor(
    @Inject(BOT) private readonly bot: Bot<BotContext>,
    private readonly config: BaseConfigService
  ) {}

  /**
   * Формирует текст уведомления. Вынесено отдельно, чтобы тестировать без сети.
   */
  public buildStartupMessage(now: Date = new Date()): string {
    return (
      `🚀 Бот запущен\n` +
      `Версия: ${APP_VERSION}\n` +
      `Окружение: ${this.config.tgEnv}\n` +
      `Время: ${now.toISOString()}`
    );
  }

  /** Отправляет уведомление владельцу; при сбое пишет предупреждение в лог. */
  public async onApplicationBootstrap(): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.config.ownerId, this.buildStartupMessage());
      this.logger.log(`Уведомление о старте отправлено владельцу (версия ${APP_VERSION})`);
    } catch (error) {
      this.logger.warn(
        `Не удалось отправить уведомление о старте: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
