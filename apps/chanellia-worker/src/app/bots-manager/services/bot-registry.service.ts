import {Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {ManagedBotContext} from '../interfaces/managed-bot-context.interface';
import {ClientEntityInterface} from '@chanellia/common';

interface RegistryContextInterface {
  bot: Bot<ManagedBotContext>;
  client: ClientEntityInterface;
}

@Injectable()
export class BotRegistryService {
  private readonly botRegistry: Map<number, RegistryContextInterface> = new Map();

  public addBot(id: number, context: RegistryContextInterface): void {
    this.botRegistry.set(id, context);
  }

  public activeBotIds(): number[] {
    return Array.from(this.botRegistry.keys());
  }

  public activeBotsWithContext(): RegistryContextInterface[] {
    return Array.from(this.botRegistry.values());
  }

  public hasBot(id: number): boolean {
    return this.botRegistry.has(id);
  }
}
