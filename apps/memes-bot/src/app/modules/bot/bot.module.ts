import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '../config/app-config.module';
import { CringePostEntity } from './entities/cringe-post.entity';
import { PostSchedulerEntity } from './entities/post-scheduler.entity';
import { PublishedPostHashesEntity } from './entities/published-post-hashes.entity';
import { SettingsEntity } from './entities/settings.entity';
import { UserRequestEntity } from './entities/user-request.entity';
import { UserEntity } from './entities/user.entity';
import { BotConfigMiddleware } from './providers/bot-config.middleware';
import { BOT_PROVIDER } from './providers/bot.provider';
import { CringeManagementService } from './services/cringe-management.service';
import { DeduplicationService } from './services/deduplication.service';
import { PostSchedulerService } from './services/post-scheduler.service';
import { SettingsService } from './services/settings.service';
import { UserRequestService } from './services/user-request.service';
import { UserService } from './services/user.service';
import { SessionManagerService } from './session/session-manager.service';
import { SessionEntity } from './session/session.entity';

@Module({
  imports: [
    AppConfigModule,
    HttpModule,
    TypeOrmModule.forFeature([
      SessionEntity,
      UserEntity,
      UserRequestEntity,
      PostSchedulerEntity,
      SettingsEntity,
      CringePostEntity,
      PublishedPostHashesEntity,
    ]),
  ],
  providers: [
    BOT_PROVIDER,
    BotConfigMiddleware,
    SessionManagerService,
    UserService,
    UserRequestService,
    PostSchedulerService,
    SettingsService,
    CringeManagementService,
    DeduplicationService,
  ],
  exports: [
    BOT_PROVIDER,
    UserService,
    UserRequestService,
    PostSchedulerService,
    SettingsService,
    CringeManagementService,
    DeduplicationService,
  ],
})
export class BotModule {}
