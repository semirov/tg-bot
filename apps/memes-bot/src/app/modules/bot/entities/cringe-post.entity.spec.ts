import { CringePostEntity } from './cringe-post.entity';

describe('CringePostEntity', () => {
  it('хранит идентификаторы сообщений и флаги переноса', () => {
    const entity = new CringePostEntity();
    const createdAt = new Date('2026-09-18T10:00:00.000Z');

    Object.assign(entity, {
      id: 5,
      requestChannelMessageId: 10,
      memeChannelMessageId: 20,
      cringeChannelMessageId: 30,
      isUserPost: true,
      isMovedToCringe: true,
      createdAt,
    });

    expect(entity).toMatchObject({
      id: 5,
      requestChannelMessageId: 10,
      memeChannelMessageId: 20,
      cringeChannelMessageId: 30,
      isUserPost: true,
      isMovedToCringe: true,
    });
    expect(entity.createdAt).toBe(createdAt);
  });

  it('допускает незаполненные необязательные поля', () => {
    const entity = new CringePostEntity();

    expect(entity.requestChannelMessageId).toBeUndefined();
    expect(entity.memeChannelMessageId).toBeUndefined();
    expect(entity.cringeChannelMessageId).toBeUndefined();
    expect(entity.isUserPost).toBeUndefined();
    expect(entity.isMovedToCringe).toBeUndefined();
    expect(entity.createdAt).toBeUndefined();
  });
});
