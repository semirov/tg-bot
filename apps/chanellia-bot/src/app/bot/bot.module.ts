import {Module} from '@nestjs/common';
import {LIGHT_HOUSE_BOT_PROVIDER} from './providers/bot.provider';
import {BotConfigMiddleware} from './providers/bot-config.middleware';
import {TypeOrmModule} from '@nestjs/typeorm';
import {HttpModule} from '@nestjs/axios';
import {SessionEntity} from './entities/session.entity';
import {SessionManagerService} from './services/session-manager.service';
import {ClientEntity} from './entities/client.entity';
import {NewBotCommandHandler} from './handlers/new-bot.command-handler';
import {AppConfigModule} from '../config/app-config.module';
import {InitialQueueCheckService} from './services/initial-queue-check.service';
import {BotsQueueModule} from '../bots-queue/bots-queue.module';
import {ManagedBotLivelinessConsumer} from './services/managed-bot-liveliness.consumer';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([SessionEntity, ClientEntity]),
    AppConfigModule,
    BotsQueueModule,
  ],
  providers: [
    LIGHT_HOUSE_BOT_PROVIDER,
    BotConfigMiddleware,
    SessionManagerService,
    NewBotCommandHandler,
    InitialQueueCheckService,
    ManagedBotLivelinessConsumer,
  ],
  exports: [LIGHT_HOUSE_BOT_PROVIDER],
})
export class BotModule {
}
