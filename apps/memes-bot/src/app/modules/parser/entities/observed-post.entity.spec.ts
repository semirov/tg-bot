import { getMetadataArgsStorage } from 'typeorm';
import { ObservedPostEntity } from './observed-post.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === ObservedPostEntity && item.propertyName === propertyName
  );
}

function indexByName(name: string) {
  return getMetadataArgsStorage().indices.find(
    (item) => item.target === ObservedPostEntity && item.name === name
  );
}

describe('ObservedPostEntity', () => {
  it('уникальный ключ (sourceChatId, sourceMessageId)', () => {
    const index = indexByName('ux_observed_source_msg');
    expect(index?.columns).toEqual(['sourceChatId', 'sourceMessageId']);
    expect(index?.unique).toBe(true);
  });

  it('статус/стадия имеют дефолты', () => {
    expect(column('status')?.options).toMatchObject({ default: 'pending' });
    expect(column('evalStage')?.options).toMatchObject({ default: 'pre' });
    expect(column('mediaKind')?.options).toMatchObject({ default: 'photo' });
  });

  it('groupIds и crossLinks — jsonb', () => {
    expect(column('groupIds')?.options).toMatchObject({ type: 'jsonb', nullable: true });
    expect(column('crossLinks')?.options).toMatchObject({ type: 'jsonb', nullable: true });
  });

  it('поля склейки дублей и перцептивного хеша', () => {
    expect(column('perceptualHash')?.options).toMatchObject({ nullable: true });
    expect(column('duplicateOfId')?.options).toMatchObject({ type: 'int', nullable: true });
    expect(column('extraSources')?.options).toMatchObject({ type: 'jsonb', nullable: true });
    expect(column('rootSourceChatId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('rootSourceTitle')?.options).toMatchObject({ nullable: true });
    expect(column('rootSourceUsername')?.options).toMatchObject({ nullable: true });
  });

  it('forced по умолчанию false', () => {
    expect(column('forced')?.options).toMatchObject({ default: false });
  });

  it('экземпляр хранит значения', () => {
    const entity = new ObservedPostEntity();
    entity.sourceChatId = '-1001';
    entity.sourceMessageId = 7;
    entity.views = 1000;
    entity.score = 3.5;
    expect(entity).toMatchObject({ sourceChatId: '-1001', sourceMessageId: 7, views: 1000, score: 3.5 });
  });
});
