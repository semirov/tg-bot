import {Module} from '@nestjs/common';
import {CronService} from './service/cron.service';
import {PostManagementModule} from '../post-management/post-management.module';
import {ObservatoryModule} from '../observatory/observatory.module';
import {BotModule} from '../bot/bot.module';

@Module({
  imports: [PostManagementModule, ObservatoryModule, BotModule],
  providers: [CronService],
})
export class CronModule {
}
