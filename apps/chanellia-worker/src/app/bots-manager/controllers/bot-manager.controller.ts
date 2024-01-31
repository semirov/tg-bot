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

@Controller()
export class BotManagerController {
  constructor(
    private botRegistryService: BotRegistryService,
    @InjectQueue(QueuesEnum.BOTS_LIVELINESS)
    private botsLivelinessQueue: Queue<Partial<LivelinessMessageInterface>>,
    @InjectQueue(QueuesEnum.TEST)
    private testQueue: Queue<Partial<{ test: boolean }>>
  ) {
  }

  @MessagePattern(botManagerMessagesMap.HAS_BOT_IN_WORK)
  public checkBotInWork(botId: number): boolean {
    if (!this.botRegistryService.hasBot(botId)) {
      return;
    }
    this.botsLivelinessQueue.add(`bot_${botId}`, {id: botId, date: new Date()});
    return true;
  }

  @EventPattern(botManagerEventsMap.PING)
  public async onHandlePIngEvent(): Promise<void> {
    Logger.debug('Handle PING event', BotManagerController.name);
    for (const id of this.botRegistryService.activeBotIds()) {
      this.botsLivelinessQueue.add(`bot_${id}`, {id, date: new Date()});
    }
  }
}
