import {InjectQueue, Processor, WorkerHost} from '@nestjs/bullmq';
import {Job, Queue} from 'bullmq';
import {ContextIdFactory, ModuleRef} from '@nestjs/core';
import {BotsFactory} from '../factory/bots.factory';
import {BotsQueueService, ClientEntityInterface, LivelinessMessageInterface, QueuesEnum} from '@chanellia/common';
import {Logger} from '@nestjs/common';
import {BotRegistryService} from '../services/bot-registry.service';

@Processor(QueuesEnum.INIT_NEW_BOT, {concurrency: 100, stalledInterval: 2000})
export class BotsConsumer extends WorkerHost {
  constructor(
    private moduleRef: ModuleRef,
    private botRegistryService: BotRegistryService,
    @InjectQueue(QueuesEnum.BOTS_LIVELINESS)
    private botsLivelinessQueue: Queue<Partial<LivelinessMessageInterface>>,
    private botsQueueService: BotsQueueService,
  ) {
    super();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.worker.close();
    Logger.debug(`Prepare to shutdown ${signal || ''}`, BotsConsumer.name);

    for (const botWithContext of this.botRegistryService.activeBotsWithContext()) {
      await botWithContext.bot.stop();
      Logger.debug(`Stopped bot: ${botWithContext.client.botId}`, BotsConsumer.name);
      await this.botsQueueService.addBotToRunQueue(botWithContext.client);
    }

    return super.onApplicationShutdown(signal);
  }

  public async process(job: Job<ClientEntityInterface>): Promise<void> {
    const id = job.data.botId;
    const contextId = ContextIdFactory.create();
    const botsManagerFactory = await this.moduleRef.resolve(BotsFactory, contextId);
    const bot = await botsManagerFactory.createBot(job.data);
    this.botRegistryService.addBot(job.data.botId, {bot, client: job.data});
    this.botsLivelinessQueue.add(`bot_${id}`, {id, date: new Date()});
    Logger.debug(`Run bot: ${job.data.botId}`, BotsConsumer.name);
  }
}
