import {Injectable} from '@nestjs/common';
import {Bot} from 'grammy';
import {ManagedBotContext} from '../interfaces/managed-bot-context.interface';
import {BotEntityInterface} from '@chanellia/common';
import {ContextId} from "@nestjs/core";
import {BotsFactory} from "../factory/bots.factory";

interface RegistryContextInterface {
  bot: Bot<ManagedBotContext>;
  client: BotEntityInterface;
  botInfo: ManagedBotContext['me'];
  contextId: ContextId;
  factory: BotsFactory,
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

  public getMetadataById(botId: number): RegistryContextInterface | null {
    return this.botRegistry.get(botId) || null;
  }

  public removeBotMetadata(botId: number): void {
    this.botRegistry.delete(botId);
  }
}
