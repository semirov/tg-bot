import {Injectable} from '@nestjs/common';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
import {BotEntityInterface} from '../../interfaces';
import {QueuesEnum} from '../../constants';

@Injectable()
export class BotsQueueService {
  constructor(
    @InjectQueue(QueuesEnum.INIT_NEW_BOT) public botsQueue: Queue<BotEntityInterface>
  ) {
  }

  public async addBotToRunQueue(client: BotEntityInterface): Promise<BotEntityInterface> {
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
