import { getMetadataArgsStorage } from 'typeorm';
import { UserModeratedPostEntity } from './user-moderated-post.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === UserModeratedPostEntity && item.propertyName === propertyName
  );
}

describe('UserModeratedPostEntity', () => {
  it('зарегистрирована как таблица с автоинкрементным primary id', () => {
    const table = storage.tables.find((item) => item.target === UserModeratedPostEntity);
    const generation = storage.generations.find(
      (item) => item.target === UserModeratedPostEntity && item.propertyName === 'id'
    );

    expect(table?.type).toBe('regular');
    expect(column('id')?.options.primary).toBe(true);
    expect(generation?.strategy).toBe('increment');
  });

  it('идентификаторы сообщений и модератора — nullable bigint', () => {
    expect(column('requestChannelMessageId')?.options).toMatchObject({
      type: 'bigint',
      nullable: true,
    });
    expect(column('processedByModerator')?.options).toMatchObject({
      type: 'bigint',
      nullable: true,
    });
  });

  it('likes и dislikes — bigint по умолчанию 0', () => {
    expect(column('likes')?.options).toMatchObject({ type: 'bigint', default: 0 });
    expect(column('dislikes')?.options).toMatchObject({ type: 'bigint', default: 0 });
  });

  it('moderatedUsersCount — обязательный bigint', () => {
    expect(column('moderatedUsersCount')?.options).toMatchObject({
      type: 'bigint',
      nullable: false,
    });
  });

  it('mode, caption и hash — nullable текстовые поля', () => {
    expect(column('mode')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('caption')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(column('hash')?.options).toMatchObject({
      type: 'varchar',
      length: 64,
      nullable: true,
    });
  });

  it('isApproved / isRejected / moderatedTo имеют корректные дефолты', () => {
    expect(column('isApproved')?.options).toMatchObject({ type: 'boolean', default: false });
    expect(column('isRejected')?.options).toMatchObject({ type: 'boolean', default: false });
    expect(column('moderatedTo')?.options).toMatchObject({
      type: 'timestamptz',
      nullable: true,
      default: null,
    });
  });

  it('перечисляет ровно ожидаемый набор колонок', () => {
    const properties = storage.columns
      .filter((item) => item.target === UserModeratedPostEntity)
      .map((item) => item.propertyName)
      .sort();

    expect(properties).toEqual([
      'caption',
      'dislikes',
      'hash',
      'id',
      'isApproved',
      'isRejected',
      'likes',
      'mode',
      'moderatedTo',
      'moderatedUsersCount',
      'processedByModerator',
      'requestChannelMessageId',
    ]);
  });
});
