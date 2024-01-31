import {Processor, WorkerHost} from '@nestjs/bullmq';
import {Job} from 'bullmq';

import {QueuesEnum} from '@chanellia/common';
import {Logger, OnApplicationShutdown} from '@nestjs/common';

@Processor(QueuesEnum.TEST, {
  concurrency: 1,
  maxStalledCount: 1000,
  stalledInterval: 5000,
  removeOnComplete: {count: 100, age: 60 * 60 * 3},
})
export class TestConsumer extends WorkerHost implements OnApplicationShutdown {
  constructor() {
    super();
  }

  onApplicationShutdown(signal?: string): Promise<void> {
    this.worker.close();
    return super.onApplicationShutdown(signal);
  }

  public async process(job: Job<{ test: boolean }>): Promise<void> {
    job.log('in work ' + new Date().toISOString());
    Logger.log('HANDLE JOB', job.id, TestConsumer.name);
    return new Promise(() => {
    });
  }
}
