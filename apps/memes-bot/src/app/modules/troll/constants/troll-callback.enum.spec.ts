import { TROLL_CALLBACK_REGEXP, TrollCallbackEnum } from './troll-callback.enum';

describe('troll-callback', () => {
  it('содержит префиксы подтверждения и отклонения', () => {
    expect(TrollCallbackEnum.APPROVE_PREFIX).toBe('troll:approve:');
    expect(TrollCallbackEnum.REJECT_PREFIX).toBe('troll:reject:');
  });

  it('разбирает callback-данные approve/reject с id чата', () => {
    expect(TROLL_CALLBACK_REGEXP.test('troll:approve:-100500')).toBe(true);
    expect(TROLL_CALLBACK_REGEXP.test('troll:reject:123')).toBe(true);
  });

  it('отвергает чужие и битые callback-данные', () => {
    expect(TROLL_CALLBACK_REGEXP.test('troll:approve:abc')).toBe(false);
    expect(TROLL_CALLBACK_REGEXP.test('troll:other:1')).toBe(false);
    expect(TROLL_CALLBACK_REGEXP.test('approve:1')).toBe(false);
    expect(TROLL_CALLBACK_REGEXP.test('troll:approve:1:2')).toBe(false);
  });
});
