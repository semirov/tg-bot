import {Controller, Logger} from '@nestjs/common';
import {EventPattern, MessagePattern} from '@nestjs/microservices';
import {
  botManagerEventsMap,
  botManagerMessagesMap,
  LivelinessMessageInterface,
  QueuesEnum,
} from '@chanellia/common';
import {BotRegistryService} from '../services/bot-registry.service';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
import {ManagedBotContext} from '../interfaces/managed-bot-context.interface';

@Controller()
export class BotManagerController {
  constructor(
    private botRegistryService: BotRegistryService,
    @InjectQueue(QueuesEnum.BOTS_LIVELINESS)
    private botsLivelinessQueue: Queue<Partial<LivelinessMessageInterface>>
  ) {
  }

  @MessagePattern(botManagerMessagesMap.HAS_BOT_IN_WORK)
  public checkBotInWork(botId: number): { hasBot: boolean } {
    if (!this.botRegistryService.hasBot(botId)) {
      return {hasBot: false};
    }
    this.botsLivelinessQueue.add(
      `bot_${botId}`,
      {id: botId, date: new Date()},
      {removeOnFail: true, removeOnComplete: true}
    );
    return {hasBot: true};
  }

  @MessagePattern(botManagerMessagesMap.GET_BOT_INFO)
  public onGetBotInfo(botId: number): ManagedBotContext['me'] {
    const botMetadata = this.botRegistryService.getMetadataById(botId);
    return botMetadata?.botInfo || null;
  }

  @EventPattern(botManagerEventsMap.PING)
  public async onHandlePIngEvent(): Promise<void> {
    for (const id of this.botRegistryService.activeBotIds()) {
      this.botsLivelinessQueue.add(`bot_${id}`, {id, date: new Date()});
    }
  }
}
