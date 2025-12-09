import { Module } from '@nestjs/common';
import { CronService } from './service/cron.service';
import { PostManagementModule } from '../post-management/post-management.module';
import { ObservatoryModule } from '../observatory/observatory.module';
import { BotModule } from '../bot/bot.module';
import { MonthlyStatService } from './service/monthly-stat.service';
import { AppConfigModule } from '../config/app-config.module';
import { YearResultsModule } from '../year-results/year-results.module';

@Module({
  imports: [PostManagementModule, ObservatoryModule, BotModule, AppConfigModule, YearResultsModule],
  providers: [CronService, MonthlyStatService],
})
export class CronModule {}
