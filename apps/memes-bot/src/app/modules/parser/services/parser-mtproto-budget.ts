import {
  MTPROTO_HISTORY_BURST,
  MTPROTO_HISTORY_PER_HOUR,
  MTPROTO_METADATA_BURST,
  MTPROTO_METADATA_PER_HOUR,
} from '../constants/parser.constants';

/** Полоса бюджета сбора MTProto. */
export type MtprotoBucket = 'history' | 'metadata';

/** Политика полосы: запас (burst) и пополнение, вызовов в час. */
export interface MtprotoBucketPolicy {
  capacity: number;
  refillPerHour: number;
}

/** Дефолтные политики: см. комментарии к константам (прод-инцидент TGB-125). */
export const MTPROTO_BUCKET_POLICIES: Record<MtprotoBucket, MtprotoBucketPolicy> = {
  history: { capacity: MTPROTO_HISTORY_BURST, refillPerHour: MTPROTO_HISTORY_PER_HOUR },
  metadata: { capacity: MTPROTO_METADATA_BURST, refillPerHour: MTPROTO_METADATA_PER_HOUR },
};

/**
 * Операции сбора → полоса бюджета. Всё, чего здесь нет (доставка
 * `getMessages:deliver`, `downloadMedia`, `downloadThumb`, оценка
 * `getMessages:eval`/`:refresh`), идёт без бюджета: выдача и оценка не должны
 * голодать из-за сбора.
 */
const BUCKET_BY_OPERATION: Readonly<Record<string, MtprotoBucket>> = {
  getHistory: 'history',
  'getHistory:seed': 'history',
  'getMessages:ids': 'history',
  getFullChannel: 'metadata',
  getEntity: 'metadata',
  getDialogs: 'metadata',
};

/** Полоса бюджета для операции или `null`, если операция вне бюджета. */
export const budgetBucketFor = (operation: string): MtprotoBucket | null =>
  BUCKET_BY_OPERATION[operation] ?? null;

/**
 * Token-bucket бюджет MTProto-вызовов сбора (TGB-125).
 *
 * Токены копятся до `capacity` (burst) и пополняются непрерывно
 * `refillPerHour / 3600000` за мс — дробные токены разрешены, чтобы темп не
 * зависел от дискретности вызовов. Таймеров нет: пополнение считается лениво
 * на каждом обращении по инжектируемому `nowMs`, поэтому класс детерминирован
 * в тестах и не держит событийный цикл.
 *
 * Часы «назад» (немонотонное время) не отнимают уже накопленные токены:
 * состояние двигается только вперёд.
 */
export class ParserMtprotoBudget {
  private readonly state = new Map<MtprotoBucket, { tokens: number; atMs: number }>();

  constructor(private readonly policies: Record<MtprotoBucket, MtprotoBucketPolicy> = MTPROTO_BUCKET_POLICIES) {}

  /**
   * Списывает токен полосы.
   *
   * @returns `true` — вызов разрешён; `false` — бюджета нет, Telegram дёргать нельзя
   */
  public tryTake(bucket: MtprotoBucket, nowMs: number = Date.now()): boolean {
    const state = this.refill(bucket, nowMs);
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  /** Сколько целых вызовов осталось в полосе (дробный остаток не считается). */
  public remaining(bucket: MtprotoBucket, nowMs: number = Date.now()): number {
    return Math.floor(this.refill(bucket, nowMs).tokens);
  }

  /**
   * Ленивое пополнение полосы до `nowMs`.
   *
   * Первое обращение к полосе стартует с полным запасом: после рестарта
   * процесса бюджет не «наследует» простое (иначе анти-флуд обнулялся бы
   * рестартом — но и накопленного запаса сверх burst не бывает).
   */
  private refill(bucket: MtprotoBucket, nowMs: number): { tokens: number; atMs: number } {
    const policy = this.policies[bucket];
    const state = this.state.get(bucket) ?? { tokens: policy.capacity, atMs: nowMs };
    this.state.set(bucket, state);
    if (nowMs <= state.atMs) return state;

    const gained = ((nowMs - state.atMs) / 3_600_000) * policy.refillPerHour;
    state.tokens = Math.min(policy.capacity, state.tokens + gained);
    state.atMs = nowMs;
    return state;
  }
}
