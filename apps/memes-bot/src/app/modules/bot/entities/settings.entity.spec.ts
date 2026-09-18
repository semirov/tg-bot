import { getMetadataArgsStorage } from 'typeorm';
import { SettingsEntity } from './settings.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === SettingsEntity && item.propertyName === propertyName
  );
}

describe('SettingsEntity', () => {
  it('зарегистрирована как таблица с primary id bigint', () => {
    const table = storage.tables.find((item) => item.target === SettingsEntity);

    expect(table?.type).toBe('regular');
    expect(column('id')?.options).toMatchObject({ type: 'bigint', primary: true });
  });

  it('joinLink и postLinkText — nullable text', () => {
    expect(column('joinLink')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('postLinkText')?.options).toMatchObject({ type: 'text', nullable: true });
  });

  it('содержит ровно три колонки', () => {
    const properties = storage.columns
      .filter((item) => item.target === SettingsEntity)
      .map((item) => item.propertyName)
      .sort();

    expect(properties).toEqual(['id', 'joinLink', 'postLinkText']);
  });
});
