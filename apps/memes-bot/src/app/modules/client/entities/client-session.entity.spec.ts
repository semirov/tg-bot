import { getMetadataArgsStorage } from 'typeorm';
import { ClientSessionEntity } from './client-session.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === ClientSessionEntity && item.propertyName === propertyName
  );
}

describe('ClientSessionEntity', () => {
  it('id — первичный автосгенерированный ключ', () => {
    const primary = getMetadataArgsStorage().columns.find(
      (item) =>
        item.target === ClientSessionEntity &&
        item.propertyName === 'id' &&
        item.mode === 'regular'
    );
    expect(primary).toBeDefined();
    const generated = getMetadataArgsStorage().generations.find(
      (item) => item.target === ClientSessionEntity
    );
    expect(generated?.strategy).toBe('increment');
    expect(column('id')?.options.type).toBe(Number);
  });

  it('station и session — nullable text-колонки', () => {
    expect(column('station')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('session')?.options).toMatchObject({ type: 'text', nullable: true });
  });

  it('isActive — boolean со значением по умолчанию false', () => {
    expect(column('isActive')?.options).toMatchObject({ type: 'boolean', default: false });
  });

  it('экземпляр хранит переданные значения (в т.ч. дефолт TypeORM)', () => {
    const entity = new ClientSessionEntity();
    entity.id = 5;
    entity.station = 'main';
    entity.session = 'session-string';
    entity.isActive = true;

    expect(entity.id).toBe(5);
    expect(entity.station).toBe('main');
    expect(entity.session).toBe('session-string');
    expect(entity.isActive).toBe(true);
  });
});
