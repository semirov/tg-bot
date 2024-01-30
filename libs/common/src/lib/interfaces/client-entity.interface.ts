export interface ClientEntityInterface {
  id: number;
  adminUserId: number;
  botId: number;
  botToken: string;
  active: boolean;
  createdAt: Date;
  lastPing: Date;
}
