import {
  MTPROTO_HISTORY_BURST,
  MTPROTO_HISTORY_PER_HOUR,
  MTPROTO_METADATA_BURST,
  MTPROTO_METADATA_PER_HOUR,
} from '../constants/parser.constants';
import {
  MTPROTO_BUCKET_POLICIES,
  ParserMtprotoBudget,
  budgetBucketFor,
} from './parser-mtproto-budget';

const T0 = new Date('2026-10-29T09:00:00Z').getTime();
const minutes = (value: number): number => T0 + value * 60_000;

describe('ParserMtprotoBudget', () => {
  let budget: ParserMtprotoBudget;

  beforeEach(() => {
    budget = new ParserMtprotoBudget();
  });

  it('дефолтные политики: history 12/20 в час, metadata 5/20 в час', () => {
    expect(MTPROTO_BUCKET_POLICIES).toEqual({
      history: { capacity: MTPROTO_HISTORY_BURST, refillPerHour: MTPROTO_HISTORY_PER_HOUR },
      metadata: { capacity: MTPROTO_METADATA_BURST, refillPerHour: MTPROTO_METADATA_PER_HOUR },
    });
  });

  it('burst: 12 вызовов history, тринадцатый — отказ; remaining считает целые вызовы', () => {
    for (let i = 0; i < MTPROTO_HISTORY_BURST; i += 1) {
      expect(budget.tryTake('history', T0)).toBe(true);
    }
    expect(budget.tryTake('history', T0)).toBe(false);
    expect(budget.remaining('history', T0)).toBe(0);
  });

  it('полосы независимы: metadata не тратит history', () => {
    for (let i = 0; i < MTPROTO_METADATA_BURST; i += 1) {
      expect(budget.tryTake('metadata', T0)).toBe(true);
    }
    expect(budget.remaining('metadata', T0)).toBe(0);
    expect(budget.remaining('history', T0)).toBe(MTPROTO_HISTORY_BURST);
  });

  it('пополнение history — 20/час: 3 минуты = 1 токен', () => {
    for (let i = 0; i < MTPROTO_HISTORY_BURST; i += 1) budget.tryTake('history', T0);
    expect(budget.remaining('history', minutes(3))).toBe(1);
    expect(budget.tryTake('history', minutes(3))).toBe(true);
    expect(budget.remaining('history', minutes(3))).toBe(0);
  });

  it('пополнение history: 15 минут = 5 токенов (20/час)', () => {
    for (let i = 0; i < MTPROTO_HISTORY_BURST; i += 1) budget.tryTake('history', T0);
    expect(budget.remaining('history', minutes(15))).toBe(5);
    expect(budget.tryTake('history', minutes(15))).toBe(true);
  });

  it('metadata: пополнение 20/час (3 минуты = 1 токен)', () => {
    for (let i = 0; i < MTPROTO_METADATA_BURST; i += 1) budget.tryTake('metadata', T0);
    expect(budget.remaining('metadata', minutes(3))).toBe(1);
    expect(budget.tryTake('metadata', minutes(3))).toBe(true);
  });

  it('дробный токен: доля не даёт вызова, но копится', () => {
    for (let i = 0; i < MTPROTO_HISTORY_BURST; i += 1) budget.tryTake('history', T0);
    // 20/час = 1/3 токена в минуту → 1.5 мин = 0.5
    expect(budget.remaining('history', minutes(1.5))).toBe(0);
    expect(budget.tryTake('history', minutes(1.5))).toBe(false);
    // ещё 1.5 мин → 1.0 токен
    expect(budget.tryTake('history', minutes(3))).toBe(true);
  });

  it('пополнение не превышает capacity', () => {
    expect(budget.remaining('history', minutes(60 * 24))).toBe(MTPROTO_HISTORY_BURST);
  });

  it('часы назад не отнимают токены и не сдвигают метку', () => {
    budget.tryTake('history', T0);
    expect(budget.tryTake('history', T0 - 60_000)).toBe(true);
    expect(budget.remaining('history', T0 - 60_000)).toBe(MTPROTO_HISTORY_BURST - 2);
  });

  it('кастомные политики подменяют дефолтные', () => {
    const tiny = new ParserMtprotoBudget({
      history: { capacity: 1, refillPerHour: 2 },
      metadata: { capacity: 1, refillPerHour: 1 },
    });
    expect(tiny.tryTake('history', T0)).toBe(true);
    expect(tiny.tryTake('history', T0)).toBe(false);
    // 2/час = 1 токен за 30 минут
    expect(tiny.tryTake('history', minutes(30))).toBe(true);
  });

  it('after restart первого обращения полоса стартует полной', () => {
    const fresh = new ParserMtprotoBudget();
    expect(fresh.remaining('metadata', minutes(600))).toBe(MTPROTO_METADATA_BURST);
  });
});

describe('budgetBucketFor', () => {
  it('history: getHistory, getHistory:seed (первичный базлайн) и getMessages:ids', () => {
    expect(budgetBucketFor('getHistory')).toBe('history');
    expect(budgetBucketFor('getHistory:seed')).toBe('history');
    expect(budgetBucketFor('getMessages:ids')).toBe('history');
  });

  it('metadata: getFullChannel, getEntity, getDialogs', () => {
    expect(budgetBucketFor('getFullChannel')).toBe('metadata');
    expect(budgetBucketFor('getEntity')).toBe('metadata');
    expect(budgetBucketFor('getDialogs')).toBe('metadata');
  });

  it('доставка, скачивание и оценка — вне бюджета', () => {
    for (const operation of [
      'getMessages:deliver',
      'downloadMedia',
      'downloadThumb',
      'getMessages:eval',
      'getMessages:refresh',
      'joinChannel',
    ]) {
      expect(budgetBucketFor(operation)).toBeNull();
    }
  });
});
