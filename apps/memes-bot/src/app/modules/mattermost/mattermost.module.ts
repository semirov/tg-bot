import { Module } from '@nestjs/common';
import { MattermostService } from './mattermost.service';
import { AppConfigModule } from '../config/app-config.module';

@Module({
  imports: [AppConfigModule],
  providers: [MattermostService],
  exports: [MattermostService],
})
export class MattermostModule {}
