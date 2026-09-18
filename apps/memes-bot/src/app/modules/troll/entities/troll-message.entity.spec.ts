import { getMetadataArgsStorage } from 'typeorm';
import { TrollMessageEntity } from './troll-message.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === TrollMessageEntity && item.propertyName === propertyName
  );
}

describe('TrollMessageEntity', () => {
  it('зарегистрирована с составным индексом chatId + id', () => {
    const table = storage.tables.find((item) => item.target === TrollMessageEntity);
    const index = storage.indices.find((item) => item.target === TrollMessageEntity);

    expect(table?.type).toBe('regular');
    expect(index?.columns).toEqual(['chatId', 'id']);
    expect(index?.unique).toBe(false);
  });

  it('id — автоинкрементный первичный ключ', () => {
    const generation = storage.generations.find(
      (item) => item.target === TrollMessageEntity && item.propertyName === 'id'
    );

    expect(column('id')?.options.primary).toBe(true);
    expect(generation?.strategy).toBe('increment');
  });

  it('chatId, role и content — обязательные с нужными типами', () => {
    expect(column('chatId')?.options).toMatchObject({ type: 'bigint' });
    expect(column('role')?.options).toMatchObject({ type: 'varchar', length: 16 });
    expect(column('content')?.options).toMatchObject({ type: 'text' });
  });

  it('userId, userName, messageId и replyToMessageId — nullable', () => {
    expect(column('userId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('userName')?.options).toMatchObject({ type: 'varchar', nullable: true });
    expect(column('messageId')?.options).toMatchObject({ type: 'int', nullable: true });
    expect(column('replyToMessageId')?.options).toMatchObject({ type: 'int', nullable: true });
  });

  it('createdAt — CreateDateColumn timestamp (не default NOW)', () => {
    const createdAt = column('createdAt');

    expect(createdAt?.mode).toBe('createDate');
    expect(createdAt?.options.type).toBe('timestamp');
  });
});
