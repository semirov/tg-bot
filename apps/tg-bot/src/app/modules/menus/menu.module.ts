import {Module} from '@nestjs/common';
import {MainMenuService} from './main-menu.service';
import {BotModule} from '../bot/bot.module';
import {AdminMenuService} from './admin-menu.service';
import {AppConfigModule} from '../config/app-config.module';
import {ModeratorMenuService} from './moderator-menu.service';
import {ClientModule} from '../client/client.module';
import {PostManagementModule} from '../post-management/post-management.module';

@Module({
  imports: [BotModule, PostManagementModule, AppConfigModule, ClientModule],
  providers: [MainMenuService, AdminMenuService, ModeratorMenuService],
  exports: [MainMenuService],
})
export class MenuModule {
}
