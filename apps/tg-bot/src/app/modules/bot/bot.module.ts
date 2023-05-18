import {Module} from '@nestjs/common';
import {BOT_PROVIDER} from './providers/bot.provider';
import {AppConfigModule} from '../config/app-config.module';
import {BotConfigMiddleware} from './providers/bot-config.middleware';
import {SessionManagerService} from './session/session-manager.service';
import {TypeOrmModule} from '@nestjs/typeorm';
import {SessionEntity} from './session/session.entity';
import {UserService} from './services/user.service';
import {UserEntity} from './entities/user.entity';
import {UserRequestEntity} from './entities/user-request.entity';
import {UserRequestService} from './services/user-request.service';
import {PostSchedulerEntity} from './entities/post-scheduler.entity';
import {PostSchedulerService} from './services/post-scheduler.service';

@Module({
  imports: [
    AppConfigModule,
    TypeOrmModule.forFeature([SessionEntity, UserEntity, UserRequestEntity, PostSchedulerEntity]),
  ],
  providers: [
    BOT_PROVIDER,
    BotConfigMiddleware,
    SessionManagerService,
    UserService,
    UserRequestService,
    PostSchedulerService,
  ],
  exports: [BOT_PROVIDER, UserService, UserRequestService, PostSchedulerService],
})
export class BotModule {
}
