export enum TrollCallbackEnum {
  APPROVE_PREFIX = 'troll:approve:',
  REJECT_PREFIX = 'troll:reject:',
}

export const TROLL_CALLBACK_REGEXP = /^troll:(approve|reject):(-?\d+)$/;
