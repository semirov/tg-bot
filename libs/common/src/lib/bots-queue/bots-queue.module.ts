import {Module} from '@nestjs/common';
import {HttpModule} from '@nestjs/axios';
import {BullModule} from '@nestjs/bullmq';
import {BotsQueueService} from './services/bots-queue.service';
import {QueuesEnum} from '../constants';
import {DefaultJobOptions} from "bullmq";

const defaultJobOptions: DefaultJobOptions = {removeOnComplete: true, removeOnFail: true};

@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue(
      {
        name: QueuesEnum.INIT_NEW_BOT,
        defaultJobOptions,
      },
      {
        name: QueuesEnum.BOTS_LIVELINESS,
        defaultJobOptions,
      },
      {
        name: QueuesEnum.BOTS_INFO_REQUEST,
        defaultJobOptions,
      }
    ),
  ],
  providers: [BotsQueueService],
  exports: [BullModule, BotsQueueService],
})
export class BotsQueueModule {
}
