import {Processor, WorkerHost} from '@nestjs/bullmq';
import {ClientEntity} from '../entities/client.entity';
import {Job} from 'bullmq';
import {InjectRepository} from '@nestjs/typeorm';
import {LessThan, Repository} from 'typeorm';
import {Inject, Logger, OnModuleInit} from '@nestjs/common';
import {sub} from 'date-fns';
import {
  botManagerEventsMap,
  botManagerMessagesMap,
  BotsQueueService,
  LivelinessMessageInterface,
  MicroservicesEnum,
  QueuesEnum,
} from '@chanellia/common';
import {ClientProxy} from '@nestjs/microservices';
import {delay, firstValueFrom} from 'rxjs';
import {Interval} from "@nestjs/schedule";

@Processor(QueuesEnum.BOTS_LIVELINESS)
export class ManagedBotLivelinessService extends WorkerHost implements OnModuleInit {
  constructor(
    @InjectRepository(ClientEntity) private clientEntityRepository: Repository<ClientEntity>,
    @InjectRepository(ClientEntity) private clientRepository: Repository<ClientEntity>,
    @Inject(MicroservicesEnum.WORKER) private microserviceClient: ClientProxy,
    private botsQueueService: BotsQueueService
  ) {
    super();
  }

  public onModuleInit(): void {
    this.sendPingEvent();
  }

  @Interval(10000)
  public sendPingEvent(): void {
    this.microserviceClient
      .emit(botManagerEventsMap.PING, [])
      .pipe(delay(5000))
      .subscribe(() => this.checkAndTryToRunBots());
  }

  private async checkAndTryToRunBots(): Promise<void> {
    const clients = await this.clientRepository.find({
      where: {active: true, lastPing: LessThan(sub(new Date(), {seconds: 20}))},
      order: {id: 'ASC'},
    });

    for (const client of clients) {
      const hasBot = await firstValueFrom(
        this.microserviceClient.emit(botManagerMessagesMap.HAS_BOT_IN_WORK, client.botId)
      );
      if (hasBot) {
        continue;
      }
      Logger.debug(`Try to run bot: ${client.botId}`, ManagedBotLivelinessService.name);
      await this.botsQueueService.addBotToRunQueue(client);
    }
  }

  public async process(job: Job<Partial<LivelinessMessageInterface>>): Promise<void> {
    const data = job.data;
    await this.clientEntityRepository.update({botId: data.id}, {lastPing: new Date()});
  }
}
