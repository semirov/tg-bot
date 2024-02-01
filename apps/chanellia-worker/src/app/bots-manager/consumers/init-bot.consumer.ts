import {Processor, WorkerHost} from '@nestjs/bullmq';
import {Job} from 'bullmq';
import {ContextIdFactory, ModuleRef} from '@nestjs/core';
import {BotsFactory} from '../factory/bots.factory';
import {
  BotsQueueService,
  ClientEntityInterface,
  QueuesEnum,
} from '@chanellia/common';
import {Logger} from '@nestjs/common';
import {BotRegistryService} from '../services/bot-registry.service';
import {BotLivelinessService} from "../services/bot-liveliness.service";

@Processor(QueuesEnum.INIT_NEW_BOT, {concurrency: 100})
export class InitBotConsumer extends WorkerHost {
  constructor(
    private moduleRef: ModuleRef,
    private botRegistryService: BotRegistryService,
    private botLivelinessService: BotLivelinessService,
    private botsQueueService: BotsQueueService
  ) {
    super();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.worker.close();
    Logger.debug(`Prepare to shutdown ${signal || ''}`, InitBotConsumer.name);
    for (const botWithContext of this.botRegistryService.activeBotsWithContext()) {
      await botWithContext.bot.stop();
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
    this.botLivelinessService.updateBotLiveliness(id);
    bot.on('message', (ctx) => ctx.reply('ok'));
    Logger.debug(`Run bot: ${botInfo.username} (${botInfo.id})`, InitBotConsumer.name);
  }
}
