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
import {ManagedBotLivelinessConsumer} from './services/managed-bot-liveliness.consumer';
import {QueueController} from "./controllers/queue.controller";
import {BotsQueueModule} from "common";
import {BullBoardModule} from "@bull-board/nestjs";
import {BullMQAdapter} from "@bull-board/api/bullMQAdapter";

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([SessionEntity, ClientEntity]),
    AppConfigModule,
    BotsQueueModule,
    BullBoardModule.forFeature(
      {
        name: 'bots',
        adapter: BullMQAdapter,
      },
      {
        name: 'bots_liveliness',
        adapter: BullMQAdapter,
      }
    ),
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
  controllers: [QueueController],
})
export class BotModule {
}
