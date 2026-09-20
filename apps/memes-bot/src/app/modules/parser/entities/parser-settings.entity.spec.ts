import { getMetadataArgsStorage } from 'typeorm';
import { PARSER_SETTINGS_ID } from '../constants/parser.constants';
import { ParserSettingsEntity } from './parser-settings.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === ParserSettingsEntity && item.propertyName === propertyName
  );
}

describe('ParserSettingsEntity', () => {
  it('singleton id и дефолты по ключам', () => {
    expect(PARSER_SETTINGS_ID).toBe(1);
    expect(column('id')?.options).toMatchObject({ primary: true });
    expect(column('enabled')?.options).toMatchObject({ default: true });
    expect(column('dailyLimit')?.options).toMatchObject({ default: 12 });
    expect(column('sourceDailyCap')?.options).toMatchObject({ default: 2 });
    expect(column('cringeShare')?.options).toMatchObject({ default: 0.25 });
    expect(column('errMin')?.options).toMatchObject({ default: 0.15 });
    expect(column('maxSources')?.options).toMatchObject({ default: 20 });
    expect(column('evalPreHours')?.options).toMatchObject({ default: 2 });
    expect(column('evalFinalHours')?.options).toMatchObject({ default: 12 });
    expect(column('candidateTtlHours')?.options).toMatchObject({ default: 48 });
    expect(column('aiEnabled')?.options).toMatchObject({ default: false });
  });

  it('экземпляр хранит значения', () => {
    const entity = new ParserSettingsEntity();
    entity.id = 1;
    entity.dailyLimit = 20;
    expect(entity).toMatchObject({ id: 1, dailyLimit: 20 });
  });
});
