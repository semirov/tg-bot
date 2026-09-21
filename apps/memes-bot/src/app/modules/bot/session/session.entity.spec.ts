import { SessionEntity } from './session.entity';

describe('SessionEntity', () => {
  it('создаётся и хранит id, key и value (контракт ISession)', () => {
    const entity = new SessionEntity();
    entity.id = '42';
    entity.key = 'grammy:session:123';
    entity.value = JSON.stringify({ anonymousPublishing: false });

    expect(entity).toMatchObject({
      id: '42',
      key: 'grammy:session:123',
      value: '{"anonymousPublishing":false}',
    });
  });

  it('допускает перезапись value строкой сессии', () => {
    const entity = new SessionEntity();
    entity.id = '1';
    entity.key = 'k';
    entity.value = '{"anonymousPublishing":true}';
    entity.value = '{}';

    expect(entity.value).toBe('{}');
  });
});
