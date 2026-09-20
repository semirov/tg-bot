import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BotModule } from '../bot/bot.module';
import { PostSchedulerEntity } from '../bot/entities/post-scheduler.entity';
import { UserEntity } from '../bot/entities/user.entity';
import { ObservatoryPostEntity } from '../observatory/entities/observatory-post.entity';
import { ObservedPostEntity } from '../parser/entities/observed-post.entity';
import { SourceChannelEntity } from '../parser/entities/source-channel.entity';
import { BotTelemetryService } from './bot-telemetry.service';
import { MetricsCollectorService } from './metrics-collector.service';

/**
 * Наблюдаемость: телеметрия транспорта Telegram и бизнес-гейджи из БД.
 * HTTP-эндпоинт `/metrics` живёт на отдельном порту (см. shared/metrics).
 */
@Module({
  imports: [
    BotModule,
    TypeOrmModule.forFeature([
      SourceChannelEntity,
      ObservedPostEntity,
      ObservatoryPostEntity,
      PostSchedulerEntity,
      UserEntity,
    ]),
  ],
  providers: [BotTelemetryService, MetricsCollectorService],
})
export class MetricsModule {}
