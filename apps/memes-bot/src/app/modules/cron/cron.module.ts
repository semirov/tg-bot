import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CronService } from './service/cron.service';
import { QueueAlertService } from './service/queue-alert.service';
import { QueueAlertStateEntity } from './entities/queue-alert-state.entity';
import { PostManagementModule } from '../post-management/post-management.module';
import { ObservatoryModule } from '../observatory/observatory.module';
import { BotModule } from '../bot/bot.module';
import { MonthlyStatService } from './service/monthly-stat.service';
import { AppConfigModule } from '../config/app-config.module';
import { YearResultsModule } from '../year-results/year-results.module';

@Module({
  imports: [
    PostManagementModule,
    ObservatoryModule,
    BotModule,
    AppConfigModule,
    YearResultsModule,
    TypeOrmModule.forFeature([QueueAlertStateEntity]),
  ],
  providers: [CronService, MonthlyStatService, QueueAlertService],
})
export class CronModule {}
