import { Injectable, Logger } from '@nestjs/common';
import { ClientBaseService } from '../../client/services/client-base.service';
import { TelegramClient } from 'telegram';

/** Единая точка доступа парсера к MTProto-клиенту юзербота. */
@Injectable()
export class ParserClientService {
  private readonly logger = new Logger(ParserClientService.name);

  constructor(private readonly clientBase: ClientBaseService) {}

  /** Клиент не поднят (наблюдатель выключен) → undefined и один warning. */
  public client(): TelegramClient | undefined {
    const client = this.clientBase.activeClient;
    if (!client) {
      this.logger.debug('Parser: MTProto-клиент не поднят (observer выключен)');
      return undefined;
    }
    return client;
  }
}
