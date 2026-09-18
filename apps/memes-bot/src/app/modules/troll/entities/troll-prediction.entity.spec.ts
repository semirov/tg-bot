import { getMetadataArgsStorage } from 'typeorm';
import { TrollPredictionEntity } from './troll-prediction.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === TrollPredictionEntity && item.propertyName === propertyName
  );
}

describe('TrollPredictionEntity', () => {
  it('зарегистрирована с составным индексом chatId + userId', () => {
    const index = storage.indices.find((item) => item.target === TrollPredictionEntity);

    expect(index?.columns).toEqual(['chatId', 'userId']);
  });

  it('id — автоинкрементный первичный ключ', () => {
    const generation = storage.generations.find(
      (item) => item.target === TrollPredictionEntity && item.propertyName === 'id'
    );

    expect(column('id')?.options.primary).toBe(true);
    expect(generation?.strategy).toBe('increment');
  });

  it('chatId, userId и text — обязательные', () => {
    expect(column('chatId')?.options).toMatchObject({ type: 'bigint' });
    expect(column('userId')?.options).toMatchObject({ type: 'bigint' });
    expect(column('text')?.options).toMatchObject({ type: 'text' });
  });

  it('requests — int по умолчанию 1', () => {
    expect(column('requests')?.options).toMatchObject({ type: 'int', default: 1 });
  });

  it('createdAt — CreateDateColumn timestamp', () => {
    expect(column('createdAt')?.mode).toBe('createDate');
    expect(column('createdAt')?.options.type).toBe('timestamp');
  });
});
