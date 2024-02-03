import {QueuesEnum} from '@chanellia/common';
import {BotsRepositoryService} from './bots-repository.service';
import {Processor, WorkerHost} from "@nestjs/bullmq";
import {Job} from "bullmq";
import {BotContext} from "../interfaces/bot-context.interface";


@Processor(QueuesEnum.BOTS_INFO_REQUEST)
export class BotInfoConsumer extends WorkerHost {
  constructor(
    private clientsRepositoryService: BotsRepositoryService
  ) {
    super();
  }


  public async process(job: Job<BotContext['me']>): Promise<void> {
    const data = job.data;
    this.clientsRepositoryService.updateBotUsernameByBotId(data.id, data.username);
  }
}
