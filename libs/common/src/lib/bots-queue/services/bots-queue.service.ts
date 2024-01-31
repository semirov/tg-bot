import {Injectable} from '@nestjs/common';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
import {ClientEntityInterface} from '../../interfaces';
import {QueuesEnum} from '../../constants';

@Injectable()
export class BotsQueueService {
  constructor(
    @InjectQueue(QueuesEnum.INIT_NEW_BOT) private botsQueue: Queue<ClientEntityInterface>
  ) {
  }

  public async addBotToRunQueue(client: ClientEntityInterface): Promise<ClientEntityInterface> {
    const id = `bot_${client.botId}`;
    const job = await this.botsQueue.add(id, client, {
      jobId: id,
      attempts: 5,
      removeOnFail: true,
      removeOnComplete: true,
      backoff: {
        delay: 1000,
        type: 'fixed',
      },
    });

    return job.data;
  }
}
