import {Inject, Injectable} from '@nestjs/common';
import {botManagerEventsMap, botManagerMessagesMap, MicroservicesEnum} from '@chanellia/common';
import {ClientProxy} from '@nestjs/microservices';
import {firstValueFrom, map, Observable} from 'rxjs';
import {BotContext} from '../interfaces/bot-context.interface';
import {ClientsRepositoryService} from './clients-repository.service';

@Injectable()
export class ManagedBotService {
  constructor(
    @Inject(MicroservicesEnum.WORKER) private microserviceClient: ClientProxy,
    private clientsRepositoryService: ClientsRepositoryService
  ) {
  }

  public pingWorkers(): Observable<void> {
    return this.microserviceClient.emit(botManagerEventsMap.PING, []);
  }

  public hasBotInWork(botId: number): Observable<boolean> {
    return this.microserviceClient
      .send<{ hasBot: boolean }>(botManagerMessagesMap.HAS_BOT_IN_WORK, botId)
      .pipe(map((result) => result.hasBot));
  }

  public getBotInfoById(botId: number): Observable<BotContext['me']> {
    return this.microserviceClient.send(botManagerMessagesMap.GET_BOT_INFO, botId);
  }

  public async actualizeBotNamesByAdminId(adminId: number): Promise<void> {
    const botIds = await this.clientsRepositoryService.getBotIdsByAdminId(adminId);
    for (const botId of botIds) {
      const botInfo = await firstValueFrom(this.getBotInfoById(botId));
      await this.clientsRepositoryService.updateBotUsernameByBotId(botId, botInfo?.username);
    }
  }
}
