export interface ClientEntityInterface {
  id: number;
  adminUserId: number;
  botId: number;
  botUsername: string;
  botToken: string;
  active: boolean;
  createdAt: Date;
  lastPing: Date;
}
