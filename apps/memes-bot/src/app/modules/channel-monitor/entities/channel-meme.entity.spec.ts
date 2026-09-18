import { getMetadataArgsStorage } from 'typeorm';
import { ChannelMemeEntity } from './channel-meme.entity';

const storage = getMetadataArgsStorage();

function column(propertyName: string) {
  return storage.columns.find(
    (item) => item.target === ChannelMemeEntity && item.propertyName === propertyName
  );
}

describe('ChannelMemeEntity', () => {
  it('зарегистрирована под явным именем channel_memes с автоинкрементным id', () => {
    const table = storage.tables.find((item) => item.target === ChannelMemeEntity);
    const generation = storage.generations.find(
      (item) => item.target === ChannelMemeEntity && item.propertyName === 'id'
    );

    expect(table?.name).toBe('channel_memes');
    expect(column('id')?.options.primary).toBe(true);
    expect(generation?.strategy).toBe('increment');
  });

  it('channelId/channelType/s3Key — обязательные varchar с ограничением длины', () => {
    expect(column('channelId')?.options).toMatchObject({ type: 'varchar', length: 255 });
    expect(column('channelType')?.options).toMatchObject({ type: 'varchar', length: 50 });
    expect(column('s3Key')?.options).toMatchObject({ type: 'varchar', length: 500 });
  });

  it('messageId — обязательный bigint', () => {
    expect(column('messageId')?.options).toMatchObject({ type: 'bigint' });
  });

  it('caption, fileId и fileSize — nullable', () => {
    expect(column('caption')?.options).toMatchObject({
      type: 'varchar',
      length: 1000,
      nullable: true,
    });
    expect(column('fileId')?.options).toMatchObject({
      type: 'varchar',
      length: 100,
      nullable: true,
    });
    expect(column('fileSize')?.options).toMatchObject({ type: 'int', nullable: true });
  });

  it('createdAt — CreateDateColumn', () => {
    expect(column('createdAt')?.mode).toBe('createDate');
  });

  it('перечисляет ровно ожидаемый набор колонок', () => {
    const properties = storage.columns
      .filter((item) => item.target === ChannelMemeEntity)
      .map((item) => item.propertyName)
      .sort();

    expect(properties).toEqual([
      'caption',
      'channelId',
      'channelType',
      'createdAt',
      'fileId',
      'fileSize',
      'id',
      'messageId',
      's3Key',
    ]);
  });
});
