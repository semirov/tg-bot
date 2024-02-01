import {InjectQueue, Processor, WorkerHost} from '@nestjs/bullmq';
import {Job, Queue} from 'bullmq';
import {ContextIdFactory, ModuleRef} from '@nestjs/core';
import {BotsFactory} from '../factory/bots.factory';
import {
  BotsQueueService,
  ClientEntityInterface,
  LivelinessMessageInterface,
  QueuesEnum,
} from '@chanellia/common';
import {Logger} from '@nestjs/common';
import {BotRegistryService} from '../services/bot-registry.service';

@Processor(QueuesEnum.INIT_NEW_BOT, {concurrency: 1, maxStalledCount: 10000})
export class InitBotConsumer extends WorkerHost {
  constructor(
    private moduleRef: ModuleRef,
    private botRegistryService: BotRegistryService,
    @InjectQueue(QueuesEnum.BOTS_LIVELINESS)
    private botsLivelinessQueue: Queue<Partial<LivelinessMessageInterface>>,
    private botsQueueService: BotsQueueService
  ) {
    super();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.worker.close();
    Logger.debug(`Prepare to shutdown ${signal || ''}`, InitBotConsumer.name);

    for (const botWithContext of this.botRegistryService.activeBotsWithContext()) {
      await botWithContext.bot.stop();
      Logger.debug(`Stopped bot: ${botWithContext.client.botId}`, InitBotConsumer.name);
      await this.botsQueueService.addBotToRunQueue(botWithContext.client);
    }

    return super.onApplicationShutdown(signal);
  }

  public async process(job: Job<ClientEntityInterface>): Promise<void> {
    const id = job.data.botId;
    const contextId = ContextIdFactory.create();
    const botsManagerFactory = await this.moduleRef.resolve(BotsFactory, contextId);
    const bot = await botsManagerFactory.createBot(job.data);
    const botInfo = await bot.api.getMe();
    this.botRegistryService.addBot(job.data.botId, {bot, client: job.data, botInfo});
    this.botsLivelinessQueue.add(
      `bot_${id}`,
      {id, date: new Date()},
      {removeOnComplete: true, removeOnFail: true}
    );
    Logger.debug(`Run bot: ${job.data.botId}`, InitBotConsumer.name);
  }
}
