import {OnQueueEvent, QueueEventsHost, QueueEventsListener} from '@nestjs/bullmq';
import {QueuesEnum} from '@chanellia/common';

@QueueEventsListener(QueuesEnum.INIT_NEW_BOT)
export class ManagedBotEventsService extends QueueEventsHost {
  @OnQueueEvent('stalled')
  public onJobStalled(args) {
    console.log(args);
    // do some stuff
  }
}
