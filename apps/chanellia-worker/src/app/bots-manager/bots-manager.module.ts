import {Module} from '@nestjs/common';

import {HttpModule} from '@nestjs/axios';

import {BotsConsumer} from "./consumers/bots.consumer";
import {TypeOrmModule} from "@nestjs/typeorm";
import {BotsSessionEntity} from "./entities/bots-session.entity";
import {BotsFactory} from "./factory/bots.factory";
import {BotsUsersEntity} from "./entities/bots-users.entity";
import {MessageHandler} from "./services/message.handler";
import {BotsQueueModule} from "common";

@Module({
  imports: [
    HttpModule,
    BotsQueueModule,
    TypeOrmModule.forFeature([BotsSessionEntity, BotsUsersEntity]),
  ],
  providers: [BotsConsumer, BotsFactory, MessageHandler],
})
export class BotsManagerModule {
}
