import {Inject, Injectable} from '@nestjs/common';
import {botManagerEventsMap, botManagerMessagesMap, MicroservicesEnum} from '@chanellia/common';
import {ClientProxy} from '@nestjs/microservices';
import {map, Observable} from 'rxjs';
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

  public async actualizeBotNamesByAdminId(adminId: number): Promise<void> {
    const botIds = await this.clientsRepositoryService.getBotIdsByAdminId(adminId);
    for (const botId of botIds) {
      this.microserviceClient.emit(botManagerEventsMap.GET_BOT_INFO, botId);
    }
  }
}
