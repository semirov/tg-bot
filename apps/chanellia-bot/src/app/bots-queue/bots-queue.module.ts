import {Module} from '@nestjs/common';
import {HttpModule} from '@nestjs/axios';
import {AppConfigModule} from '../config/app-config.module';
import {QueueController} from './controllers/queue.controller';
import {BullModule} from '@nestjs/bullmq';
import {BullBoardModule} from '@bull-board/nestjs';
import {BullMQAdapter} from '@bull-board/api/bullMQAdapter';
import {BotsQueueService} from './services/bots-queue.service';

@Module({
  imports: [
    HttpModule,
    AppConfigModule,
    BullModule.registerQueue(
      {
        name: 'bots',
      },
      {
        name: 'bots_liveliness',
      }
    ),
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
  providers: [BotsQueueService],
  controllers: [QueueController],
  exports: [BullModule, BotsQueueService],
})
export class BotsQueueModule {
}
