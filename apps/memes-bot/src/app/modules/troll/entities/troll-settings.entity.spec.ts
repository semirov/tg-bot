import { getMetadataArgsStorage } from 'typeorm';
import { TrollSettingsEntity } from './troll-settings.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === TrollSettingsEntity && item.propertyName === propertyName
  );
}

describe('TrollSettingsEntity', () => {
  it('зарегистрирована как синглтон-таблица с primary id', () => {
    const table = storage.tables.find((item) => item.target === TrollSettingsEntity);
    const id = column('id');

    expect(table?.type).toBe('regular');
    expect(id?.options).toMatchObject({ type: 'int', primary: true });
  });

  it('все boolean-переключатели включены по умолчанию', () => {
    const toggles = [
      'enabled',
      'criminalEnabled',
      'sarcasmEnabled',
      'mirrorEnabled',
      'reactionEnabled',
      'memeAnnounceEnabled',
      'jerkEnabled',
      'addressReactionEnabled',
      'selfCheckEnabled',
      'memberTagsEnabled',
      'memberBioEnabled',
      'visionEnabled',
      'useProModel',
    ];

    for (const toggle of toggles) {
      expect(column(toggle)?.options).toMatchObject({ type: 'boolean', default: true });
    }
  });

  it('пороги (real) имеют ожидаемые дефолты', () => {
    expect(column('criminalThreshold')?.options).toMatchObject({ type: 'real', default: 0.5 });
    expect(column('criminalHighThreshold')?.options).toMatchObject({
      type: 'real',
      default: 0.8,
    });
    expect(column('sarcasmChance')?.options).toMatchObject({ type: 'real', default: 0.05 });
    expect(column('mirrorChance')?.options).toMatchObject({ type: 'real', default: 0.05 });
    expect(column('reactionChance')?.options).toMatchObject({ type: 'real', default: 0.05 });
    expect(column('memeAnnounceChance')?.options).toMatchObject({ type: 'real', default: 0.1 });
    expect(column('selfCheckThreshold')?.options).toMatchObject({ type: 'real', default: 0.6 });
  });

  it('кулдауны и лимиты (int) имеют ожидаемые дефолты', () => {
    expect(column('sarcasmCooldownSec')?.options).toMatchObject({ type: 'int', default: 300 });
    expect(column('mirrorCooldownSec')?.options).toMatchObject({ type: 'int', default: 300 });
    expect(column('reactionCooldownSec')?.options).toMatchObject({ type: 'int', default: 60 });
    expect(column('jerkBatchWindowSec')?.options).toMatchObject({ type: 'int', default: 15 });
    expect(column('jerkCooldownSec')?.options).toMatchObject({ type: 'int', default: 180 });
    expect(column('dialogPauseMin')?.options).toMatchObject({ type: 'int', default: 15 });
    expect(column('analyzeCooldownSec')?.options).toMatchObject({ type: 'int', default: 15 });
    expect(column('dailyRequestLimit')?.options).toMatchObject({ type: 'int', default: 2000 });
    expect(column('maxInputChars')?.options).toMatchObject({ type: 'int', default: 1000 });
  });

  it('updatedAt — UpdateDateColumn timestamp', () => {
    const updatedAt = column('updatedAt');

    expect(updatedAt?.mode).toBe('updateDate');
    expect(updatedAt?.options.type).toBe('timestamp');
  });
});
