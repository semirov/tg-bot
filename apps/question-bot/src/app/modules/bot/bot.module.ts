import { Module } from '@nestjs/common';
import { BOT_PROVIDER } from './providers/bot.provider';
import { AppConfigModule } from '../config/app-config.module';
import { BotConfigMiddleware } from './providers/bot-config.middleware';
import { SessionManagerService } from './session/session-manager.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from './session/SessionEntity';
import { UserService } from './services/user.service';
import { HttpModule } from '@nestjs/axios';
import { MainMenuService } from './services/main-menu.service';
import { ChannelsEntity } from './entities/channels.entity';
import { UserEntity } from './entities/user.entity';
import { MessagesEntity } from './entities/messages.entity';

@Module({
  imports: [
    AppConfigModule,
    HttpModule,
    TypeOrmModule.forFeature([SessionEntity, UserEntity, ChannelsEntity, MessagesEntity]),
  ],
  providers: [
    BOT_PROVIDER,
    BotConfigMiddleware,
    SessionManagerService,
    UserService,
    MainMenuService,
  ],
  exports: [BOT_PROVIDER, UserService],
})
export class BotModule {
  constructor(private mainMenuService: MainMenuService) {
    mainMenuService.init();
  }
}
