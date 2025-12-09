import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { ClientModule } from '../client/client.module';
import { AppConfigModule } from '../config/app-config.module';
import { PostManagementModule } from '../post-management/post-management.module';
import { YearResultsModule } from '../year-results/year-results.module';
import { AdminMenuService } from './admin-menu.service';
import { MainMenuService } from './main-menu.service';
import { ModeratorMenuService } from './moderator-menu.service';

@Module({
  imports: [BotModule, PostManagementModule, AppConfigModule, ClientModule, YearResultsModule],
  providers: [MainMenuService, AdminMenuService, ModeratorMenuService],
  exports: [MainMenuService],
})
export class MenuModule {}
