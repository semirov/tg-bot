import {UserEntityInterface} from "./user-entity.interface";

export interface BotEntityInterface {
  id: number;
  botId: number;
  user: Partial<UserEntityInterface>;
  botUsername: string;
  botToken: string;
  createdAt: Date;
  lastPing: Date;
}
