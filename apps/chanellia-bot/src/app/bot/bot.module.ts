import {Module} from '@nestjs/common';
import {LIGHT_HOUSE_BOT_PROVIDER} from './providers/bot.provider';
import {BotConfigMiddleware} from './providers/bot-config.middleware';
import {TypeOrmModule} from '@nestjs/typeorm';
import {HttpModule} from '@nestjs/axios';
import {SessionEntity} from './entities/session.entity';
import {SessionManagerService} from './services/session-manager.service';
import {ClientEntity} from './entities/client.entity';
import {NewBotBotCommand} from './handlers/new-bot.bot-command';
import {AppConfigModule} from '../config/app-config.module';
import {ManagedBotLivelinessService} from './services/managed-bot-liveliness.service';
import {QueueController} from './controllers/queue.controller';
import {BotsQueueModule, QueuesEnum} from '@chanellia/common';
import {BullBoardModule} from '@bull-board/nestjs';
import {BullAdapter} from '@bull-board/api/bullAdapter';
import {ManagedBotService} from './services/managed-bot.service';
import {ClientsRepositoryService} from './services/clients-repository.service';
import {MyBotsBotCommand} from './handlers/my-bots.bot-command';
import {ManagedBotEventsService} from './services/managed-bot-events.service';
import {BotInfoConsumer} from "./services/bot-info.consumer";

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([SessionEntity, ClientEntity]),
    AppConfigModule,
    BotsQueueModule,
    BullBoardModule.forFeature(
      {
        name: QueuesEnum.INIT_NEW_BOT,
        adapter: BullAdapter,
      },
      {
        name: QueuesEnum.BOTS_LIVELINESS,
        adapter: BullAdapter,
      }
    ),
  ],
  providers: [
    LIGHT_HOUSE_BOT_PROVIDER,
    BotConfigMiddleware,
    SessionManagerService,
    NewBotBotCommand,
    ManagedBotLivelinessService,
    ManagedBotService,
    ClientsRepositoryService,
    MyBotsBotCommand,
    ManagedBotEventsService,
    BotInfoConsumer,
  ],
  exports: [LIGHT_HOUSE_BOT_PROVIDER],
  controllers: [QueueController],
})
export class BotModule {
}
