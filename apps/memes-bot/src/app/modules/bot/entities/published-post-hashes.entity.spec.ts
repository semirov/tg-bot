import { PublishedPostHashesEntity } from './published-post-hashes.entity';

describe('PublishedPostHashesEntity', () => {
  it('хранит id сообщения канала, хэш и дату', () => {
    const entity = new PublishedPostHashesEntity();
    const createdAt = new Date('2026-09-18T10:00:00.000Z');

    Object.assign(entity, {
      id: 1,
      memeChannelMessageId: 777,
      hash: 'a'.repeat(64),
      createdAt,
    });

    expect(entity.id).toBe(1);
    expect(entity.memeChannelMessageId).toBe(777);
    expect(entity.hash).toHaveLength(64);
    expect(entity.createdAt).toBe(createdAt);
  });

  it('позволяет создать запись с пустым хэшем', () => {
    const entity = new PublishedPostHashesEntity();

    expect(entity.hash).toBeUndefined();
    expect(entity.memeChannelMessageId).toBeUndefined();
    expect(entity.createdAt).toBeUndefined();
  });
});
