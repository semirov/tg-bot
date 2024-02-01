import {Module} from '@nestjs/common';

import {HttpModule} from '@nestjs/axios';

import {InitBotConsumer} from './consumers/init-bot.consumer';
import {TypeOrmModule} from '@nestjs/typeorm';
import {BotsSessionEntity} from './entities/bots-session.entity';
import {BotsFactory} from './factory/bots.factory';
import {BotsUsersEntity} from './entities/bots-users.entity';
import {MessageHandler} from './services/message.handler';
import {BotsQueueModule} from '@chanellia/common';
import {BotManagerController} from './controllers/bot-manager.controller';
import {BotRegistryService} from './services/bot-registry.service';
import {BotLivelinessService} from "./services/bot-liveliness.service";

@Module({
  imports: [
    HttpModule,
    BotsQueueModule,
    TypeOrmModule.forFeature([BotsSessionEntity, BotsUsersEntity]),
  ],
  providers: [InitBotConsumer, BotsFactory, MessageHandler, BotRegistryService, BotLivelinessService],
  controllers: [BotManagerController],
})
export class BotsManagerModule {
}
