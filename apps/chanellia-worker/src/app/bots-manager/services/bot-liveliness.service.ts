import {Injectable} from '@nestjs/common';
import {Queue} from "bullmq";
import {LivelinessMessageInterface, QueuesEnum} from "@chanellia/common";
import {InjectQueue} from "@nestjs/bullmq";

@Injectable()
export class BotLivelinessService {
  constructor(
    @InjectQueue(QueuesEnum.BOTS_LIVELINESS)
    private botsLivelinessQueue: Queue<Partial<LivelinessMessageInterface>>,
  ) {
  }


  public updateBotLiveliness(id: number): void {
    const jobId = `bot_${id}`;
    this.botsLivelinessQueue.add(jobId, {id, date: new Date()}, {jobId});
  }
}
