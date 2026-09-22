import { getMetadataArgsStorage } from 'typeorm';
import { TrollMemberTagEntity } from './troll-member-tag.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === TrollMemberTagEntity && item.propertyName === propertyName
  );
}

describe('TrollMemberTagEntity', () => {
  it('зарегистрирована как обычная таблица', () => {
    const table = storage.tables.find((item) => item.target === TrollMemberTagEntity);

    expect(table?.type).toBe('regular');
    expect(table?.name).toBeUndefined();
  });

  it('id — первичный ключ', () => {
    expect(column('id')?.options.primary).toBe(true);
  });

  it('chatId и userId — bigint, не nullable', () => {
    expect(column('chatId')?.options).toMatchObject({ type: 'bigint' });
    expect(column('userId')?.options).toMatchObject({ type: 'bigint' });
  });

  it('tag — varchar(16) (лимит Telegram)', () => {
    expect(column('tag')?.options).toMatchObject({ type: 'varchar', length: 16, nullable: true });
  });

  it('userName, reason, topics — nullable', () => {
    expect(column('userName')?.options).toMatchObject({ type: 'varchar', nullable: true });
    expect(column('reason')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('topics')?.options).toMatchObject({ type: 'text', nullable: true });
  });

  it('updatedAt — автоматическая timestamp-колонка', () => {
    expect(column('updatedAt')?.mode).toBe('updateDate');
    expect(column('updatedAt')?.options.type).toBe('timestamp');
  });

  it('есть уникальный индекс по (chatId, userId)', () => {
    const unique = storage.uniques.find((item) => item.target === TrollMemberTagEntity);

    expect(unique?.columns).toEqual(['chatId', 'userId']);
  });
});
