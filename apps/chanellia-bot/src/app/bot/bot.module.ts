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
import {ManagedBotLivelinessService} from './services/managed-bot-liveliness.service';
import {QueueController} from "./controllers/queue.controller";
import {BotsQueueModule, QueuesEnum} from "@chanellia/common";
import {BullBoardModule} from "@bull-board/nestjs";
import {BullAdapter} from "@bull-board/api/bullAdapter";

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
    NewBotCommandHandler,
    ManagedBotLivelinessService,
  ],
  exports: [LIGHT_HOUSE_BOT_PROVIDER],
  controllers: [QueueController],
})
export class BotModule {
}
