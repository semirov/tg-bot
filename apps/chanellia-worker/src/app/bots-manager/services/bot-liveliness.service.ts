import {Injectable, Logger} from '@nestjs/common';
import {Queue} from "bullmq";
import {LivelinessMessageInterface, QueuesEnum} from "@chanellia/common";
import {InjectQueue} from "@nestjs/bullmq";
import {BotRegistryService} from "./bot-registry.service";

@Injectable()
export class BotLivelinessService {
  constructor(
    @InjectQueue(QueuesEnum.BOTS_LIVELINESS)
    private botsLivelinessQueue: Queue<Partial<LivelinessMessageInterface>>,
    private botRegistryService: BotRegistryService,
  ) {
  }

  public async stopBot(botId: number): Promise<void> {
    const metadata = this.botRegistryService.getMetadataById(botId);
    Logger.debug(
      `Stopping bot @${metadata.botInfo.username} (${botId})`,
      BotLivelinessService.name
    );
    await metadata.bot.stop();
    await metadata.factory.removeBot();
    this.botRegistryService.removeBotMetadata(botId);
  }


  public updateBotLiveliness(id: number): void {
    const jobId = `bot_${id}`;
    this.botsLivelinessQueue.add(jobId, {id, date: new Date()}, {jobId});
  }
}
