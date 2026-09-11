import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { UserPostManagementService } from './user-post-management.service';
import { AppConfigModule } from '../config/app-config.module';
import { ClientModule } from '../client/client.module';
import { AskAdminService } from './ask-admin.service';
import { MattermostModule } from '../mattermost/mattermost.module';

@Module({
  imports: [BotModule, AppConfigModule, ClientModule, MattermostModule],
  providers: [UserPostManagementService, AskAdminService],
  exports: [UserPostManagementService, AskAdminService],
})
export class PostManagementModule {}
