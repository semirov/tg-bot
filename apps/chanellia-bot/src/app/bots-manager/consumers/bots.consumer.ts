import {Processor, WorkerHost} from '@nestjs/bullmq';
import {Job} from 'bullmq';
import {ClientEntity} from '../../bot/entities/client.entity';
import {ContextIdFactory, ModuleRef} from '@nestjs/core';
import {BotsFactory} from "../factory/bots.factory";

@Processor('bots', {concurrency: 100, stalledInterval: 2000})
export class BotsConsumer extends WorkerHost {
  constructor(private moduleRef: ModuleRef) {
    super();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.worker.close();
    return super.onApplicationShutdown(signal);
  }

  public async process(job: Job<ClientEntity>): Promise<void> {
    const contextId = ContextIdFactory.create();
    const botsManagerFactory = await this.moduleRef.resolve(BotsFactory, contextId);
    const bot = await botsManagerFactory.createBot(job.data);

    console.log((await bot.api.getMe()).username);
  }
}
