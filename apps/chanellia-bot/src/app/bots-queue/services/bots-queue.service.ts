import {Injectable} from '@nestjs/common';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
import {ClientEntity} from '../../bot/entities/client.entity';

@Injectable()
export class BotsQueueService {
  constructor(@InjectQueue('bots') private botsQueue: Queue<ClientEntity>) {
  }

  public async addClientIntoQueue(client: ClientEntity): Promise<ClientEntity> {
    const id = `bot_${client.botId}`;
    const job = await this.botsQueue.add(id, client, {
      jobId: id,
      attempts: Number.MAX_SAFE_INTEGER,
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
