import {Injectable, OnModuleInit} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {ClientEntity} from '../entities/client.entity';
import {Repository} from 'typeorm';
import {BotsQueueService} from '../../bots-queue/services/bots-queue.service';

@Injectable()
export class InitialQueueCheckService implements OnModuleInit {
  constructor(
    @InjectRepository(ClientEntity) private clientRepository: Repository<ClientEntity>,
    private botsQueueService: BotsQueueService,
  ) {
  }

  public async onModuleInit(): Promise<void> {
    const clients = await this.clientRepository.find({
      where: {active: true},
      order: {id: 'ASC'},
    });

    for (const client of clients) {
      await this.botsQueueService.addClientIntoQueue(client);
    }
  }
}
