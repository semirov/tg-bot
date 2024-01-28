import {Processor, WorkerHost} from '@nestjs/bullmq';
import {ClientEntity} from '../entities/client.entity';
import {Job} from 'bullmq';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';

@Processor('bots_liveliness')
export class ManagedBotLivelinessConsumer extends WorkerHost {
  constructor(
    @InjectRepository(ClientEntity) private clientEntityRepository: Repository<ClientEntity>
  ) {
    super();
  }

  public async process(job: Job<Partial<ClientEntity>>): Promise<void> {
    const data = job.data;
    await this.clientEntityRepository.update({botId: data.botId}, {lastPing: new Date()});
  }
}
