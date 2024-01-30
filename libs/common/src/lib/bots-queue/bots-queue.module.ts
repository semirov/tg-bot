import {Module} from '@nestjs/common';
import {HttpModule} from '@nestjs/axios';
import {BullModule} from '@nestjs/bullmq';
import {BotsQueueService} from './services/bots-queue.service';

@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue(
      {
        name: 'bots',
      },
      {
        name: 'bots_liveliness',
      }
    ),
  ],
  providers: [BotsQueueService],
  exports: [BullModule, BotsQueueService],
})
export class BotsQueueModule {
}
