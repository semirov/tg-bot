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
    this.checkAndTryToRunBots();
  }


  // @Interval(5000)
  public async checkActiveTask() {
    const actives = await this.botsQueueService.botsQueue.getActive();
    for (const active of actives) {
      console.log(active);
    }
  }

  @Interval(10000)
  public sendPingEvent(): void {
    this.managedBotService
      .pingWorkers()
      .pipe(delay(5000))
      .subscribe(() => this.checkAndTryToRunBots());
  }

  private async checkAndTryToRunBots(): Promise<void> {
    const clients = await this.clientsRepositoryService.findClientUpdateMoreThanSomeSecAgo(20);

    for (const client of clients) {
      const hasBot = await firstValueFrom(this.managedBotService.hasBotInWork(client.botId));
      if (hasBot) {
        continue;
      }
      Logger.debug(`Try to run bot: ${client.botId}`, ManagedBotLivelinessService.name);
      this.botsQueueService.addBotToRunQueue(client);
    }
  }

  public async process(job: Job<Partial<LivelinessMessageInterface>>): Promise<void> {
    const data = job.data;
    await this.clientsRepositoryService.updatePartialById(data.id, {lastPing: new Date()});
  }
}
