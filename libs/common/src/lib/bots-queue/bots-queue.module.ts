import {Module} from '@nestjs/common';
import {HttpModule} from '@nestjs/axios';
import {BullModule} from '@nestjs/bullmq';
import {BotsQueueService} from './services/bots-queue.service';
import {QueuesEnum} from '../constants';

@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue(
      {
        name: QueuesEnum.INIT_NEW_BOT,
      },
      {
        name: QueuesEnum.BOTS_LIVELINESS,
      }
    ),
  ],
  providers: [BotsQueueService],
  exports: [BullModule, BotsQueueService],
})
export class BotsQueueModule {
}
