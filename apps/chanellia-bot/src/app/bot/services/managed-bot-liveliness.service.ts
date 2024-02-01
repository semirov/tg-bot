import {Processor, WorkerHost} from '@nestjs/bullmq';
import {Job} from 'bullmq';
import {Logger, OnModuleInit} from '@nestjs/common';
import {BotsQueueService, LivelinessMessageInterface, QueuesEnum} from '@chanellia/common';
import {delay, firstValueFrom} from 'rxjs';
import {Interval} from '@nestjs/schedule';
import {ManagedBotService} from './managed-bot.service';
import {ClientsRepositoryService} from './clients-repository.service';

@Processor(QueuesEnum.BOTS_LIVELINESS)
export class ManagedBotLivelinessService extends WorkerHost implements OnModuleInit {
  constructor(
    private botsQueueService: BotsQueueService,
    private managedBotService: ManagedBotService,
    private clientsRepositoryService: ClientsRepositoryService
  ) {
    super();
  }

  public onModuleInit(): void {
    this.managedBotService.pingWorkers();
  }

  @Interval(2500)
  public sendPingEvent(): void {
    this.managedBotService
      .pingWorkers()
      .pipe(delay(2500))
      .subscribe(() => this.checkAndTryToRunBots());
  }

  private async checkAndTryToRunBots(): Promise<void> {
    const clients = await this.clientsRepositoryService.findClientUpdateMoreThanSomeSecAgo(10);

    for (const client of clients) {
      Logger.debug(`Try to run bot: ${client.botId}`, ManagedBotLivelinessService.name);
      this.botsQueueService.addBotToRunQueue(client);
    }
  }

  public async process(job: Job<Partial<LivelinessMessageInterface>>): Promise<string> {
    const data = job.data;
    await this.clientsRepositoryService.updatePartialById(data.id, {lastPing: new Date()});
    return 'done';
  }
}
