import {Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {ClientEntity} from '../entities/client.entity';
import {LessThan, Repository} from 'typeorm';
import {BotsQueueService} from 'common';
import {Interval} from '@nestjs/schedule';
import {sub} from 'date-fns';

@Injectable()
export class InitialQueueCheckService {
  constructor(
    @InjectRepository(ClientEntity) private clientRepository: Repository<ClientEntity>,
    private botsQueueService: BotsQueueService
  ) {
  }

  @Interval(6000)
  private async tryToRestartNonLivelinessBots(): Promise<void> {
    const clients = await this.clientRepository.find({
      where: {active: true, lastPing: LessThan(sub(new Date(), {seconds: 12}))},
      order: {id: 'ASC'},
    });

    for (const client of clients) {
      Logger.debug(`Try to run bot: ${client.botId}`, InitialQueueCheckService.name);
      await this.botsQueueService.addClientIntoQueue(client);
    }
  }
}
