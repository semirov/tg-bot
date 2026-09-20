import { getMetadataArgsStorage } from 'typeorm';
import { SourceChannelEntity } from './source-channel.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === SourceChannelEntity && item.propertyName === propertyName
  );
}

describe('SourceChannelEntity', () => {
  it('chatId — обязательный bigint с уникальным индексом', () => {
    expect(column('chatId')?.options).toMatchObject({ type: 'bigint' });
    const index = getMetadataArgsStorage().indices.find(
      (item) => item.target === SourceChannelEntity
    );
    expect(index).toBeDefined();
  });

  it('категория и статус имеют дефолты', () => {
    expect(column('category')?.options).toMatchObject({ default: 'memes' });
    expect(column('status')?.options).toMatchObject({ default: 'active' });
  });

  it('baseline — jsonb nullable', () => {
    expect(column('baseline')?.options).toMatchObject({ type: 'jsonb', nullable: true });
  });

  it('поля интереса/чёрного списка/cooldown', () => {
    expect(column('takenTotal')?.options).toMatchObject({ default: 0 });
    expect(column('lastTakenAt')?.options).toMatchObject({ nullable: true });
    expect(column('ignoredTotal')?.options).toMatchObject({ default: 0 });
    expect(column('softIgnoredTotal')?.options).toMatchObject({ default: 0 });
    expect(column('cooldownCount')?.options).toMatchObject({ default: 0 });
    expect(column('lastIgnoredAt')?.options).toMatchObject({ nullable: true });
    expect(column('weight')?.options).toMatchObject({ default: 1 });
    expect(column('excluded')?.options).toMatchObject({ default: false });
    expect(column('excludedAt')?.options).toMatchObject({ nullable: true });
    expect(column('cooldownUntil')?.options).toMatchObject({ nullable: true });
  });

  it('экземпляр хранит значения', () => {
    const entity = new SourceChannelEntity();
    entity.chatId = '-100123';
    entity.title = 'Test';
    entity.subscribers = 42;
    entity.err = 0.2;

    expect(entity).toMatchObject({ chatId: '-100123', title: 'Test', subscribers: 42, err: 0.2 });
  });
});
