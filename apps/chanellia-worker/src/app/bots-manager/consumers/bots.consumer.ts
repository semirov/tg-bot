import {Processor, WorkerHost} from '@nestjs/bullmq';
import {Job} from 'bullmq';
import {ContextIdFactory, ModuleRef} from '@nestjs/core';
import {BotsFactory} from "../factory/bots.factory";
import {ClientEntityInterface} from "common";
import {Logger} from "@nestjs/common";

@Processor('bots', {concurrency: 100, stalledInterval: 2000})
export class BotsConsumer extends WorkerHost {
  constructor(private moduleRef: ModuleRef) {
    super();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.worker.close();
    return super.onApplicationShutdown(signal);
  }

  public async process(job: Job<ClientEntityInterface>): Promise<void> {
    const contextId = ContextIdFactory.create();
    const botsManagerFactory = await this.moduleRef.resolve(BotsFactory, contextId);
    await botsManagerFactory.createBot(job.data);
    Logger.debug(`Init bot ${job.data.botId}`, BotsConsumer.name);
  }
}
