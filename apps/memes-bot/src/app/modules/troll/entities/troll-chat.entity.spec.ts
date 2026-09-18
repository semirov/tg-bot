import { getMetadataArgsStorage } from 'typeorm';
import { TrollChatEntity } from './troll-chat.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === TrollChatEntity && item.propertyName === propertyName
  );
}

describe('TrollChatEntity', () => {
  it('зарегистрирована как обычная таблица без явного имени', () => {
    const table = storage.tables.find((item) => item.target === TrollChatEntity);

    expect(table?.type).toBe('regular');
    expect(table?.name).toBeUndefined();
  });

  it('chatId — первичный ключ bigint', () => {
    const chatId = column('chatId');

    expect(chatId?.options.primary).toBe(true);
    expect(chatId?.options.type).toBe('bigint');
  });

  it('title, addedByUserId и lastSummaryAt — nullable', () => {
    expect(column('title')?.options).toMatchObject({ type: 'varchar', nullable: true });
    expect(column('addedByUserId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('lastSummaryAt')?.options).toMatchObject({
      type: 'timestamp',
      nullable: true,
    });
  });

  it('isActive — boolean по умолчанию false', () => {
    expect(column('isActive')?.options).toMatchObject({ type: 'boolean', default: false });
  });

  it('createdAt/updatedAt — автоматические timestamp-колонки', () => {
    const createdAt = column('createdAt');
    const updatedAt = column('updatedAt');

    expect(createdAt?.mode).toBe('createDate');
    expect(createdAt?.options.type).toBe('timestamp');
    expect(updatedAt?.mode).toBe('updateDate');
    expect(updatedAt?.options.type).toBe('timestamp');
  });

  it('перечисляет ровно ожидаемый набор колонок', () => {
    const columns = storage.columns
      .filter((item) => item.target === TrollChatEntity)
      .map((item) => item.propertyName)
      .sort();

    expect(columns).toEqual(
      ['addedByUserId', 'chatId', 'createdAt', 'isActive', 'lastSummaryAt', 'title', 'updatedAt']
    );
  });
});
