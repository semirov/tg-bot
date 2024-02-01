import {Controller} from '@nestjs/common';
import {EventPattern} from '@nestjs/microservices';
import {
  botManagerEventsMap,
  QueuesEnum,
} from '@chanellia/common';
import {BotRegistryService} from '../services/bot-registry.service';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
import {ManagedBotContext} from '../interfaces/managed-bot-context.interface';
import {BotLivelinessService} from "../services/bot-liveliness.service";

@Controller()
export class BotManagerController {
  constructor(
    private botRegistryService: BotRegistryService,
    @InjectQueue(QueuesEnum.BOTS_INFO_REQUEST)
    private botsInfoRequestQueue: Queue<ManagedBotContext['me']>,
    private botLivelinessService: BotLivelinessService,
  ) {
  }

  @EventPattern(botManagerEventsMap)
  public checkBotInWork(botId: number): { hasBot: boolean } {
    if (!this.botRegistryService.hasBot(botId)) {
      return {hasBot: false};
    }
    this.botLivelinessService.updateBotLiveliness(botId);
    return {hasBot: true};
  }

  @EventPattern(botManagerEventsMap.GET_BOT_INFO)
  public async onGetBotInfo(botId: number): Promise<void> {
    const botMetadata = this.botRegistryService.getMetadataById(botId);
    if (!botMetadata?.bot) {
      return;
    }
    const botInfo = await botMetadata.bot.api.getMe();
    this.botsInfoRequestQueue.add('botInfo', botInfo);
  }

  @EventPattern(botManagerEventsMap.PING)
  public async onHandlePIngEvent(): Promise<void> {
    for (const id of this.botRegistryService.activeBotIds()) {
      this.botLivelinessService.updateBotLiveliness(id);
    }
  }
}
