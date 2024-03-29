import { Module } from '@nestjs/common';
import { BOT_PROVIDER } from './providers/bot.provider';
import { AppConfigModule } from '../config/app-config.module';
import { BotConfigMiddleware } from './providers/bot-config.middleware';
import { SessionManagerService } from './session/session-manager.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from './session/session.entity';
import { UserService } from './services/user.service';
import { UserEntity } from './entities/user.entity';
import { UserRequestEntity } from './entities/user-request.entity';
import { UserRequestService } from './services/user-request.service';
import { PostSchedulerEntity } from './entities/post-scheduler.entity';
import { PostSchedulerService } from './services/post-scheduler.service';
import { SettingsService } from './services/settings.service';
import { SettingsEntity } from './entities/settings.entity';
import { CringePostEntity } from './entities/cringe-post.entity';
import { CringeManagementService } from './services/cringe-management.service';
import { DeduplicationService } from './services/deduplication.service';
import { HttpModule } from '@nestjs/axios';
import { PublishedPostHashesEntity } from './entities/published-post-hashes.entity';

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
