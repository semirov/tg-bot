import {Module} from '@nestjs/common';
import {MainMenuService} from './main-menu.service';
import {BotModule} from '../bot/bot.module';
import {ConversationsModule} from '../conversations/conversations.module';
import {AdminMenuService} from './admin-menu.service';
import {AppConfigModule} from '../config/app-config.module';
import {ModeratorMenuService} from './moderator-menu.service';

@Module({
  imports: [BotModule, ConversationsModule, AppConfigModule],
  providers: [MainMenuService, AdminMenuService, ModeratorMenuService],
  exports: [MainMenuService],
})
export class MenuModule {
}
