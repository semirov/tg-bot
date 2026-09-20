import { getMetadataArgsStorage } from 'typeorm';
import { BestMemePostEntity } from './best-meme-post.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === BestMemePostEntity && item.propertyName === propertyName
  );
}

describe('BestMemePostEntity', () => {
  it('уникальный индекс по sourceMessageId (дедуп «Лучшего»)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (item) => item.target === BestMemePostEntity && item.name === 'ux_best_meme_source'
    );
    expect(index?.unique).toBe(true);
    expect(index?.columns).toEqual(['sourceMessageId']);
  });

  it('columns: sourceMessageId int, bestChannelMessageId bigint nullable', () => {
    expect(column('sourceMessageId')?.options).toMatchObject({ type: 'int' });
    expect(column('bestChannelMessageId')?.options).toMatchObject({
      type: 'bigint',
      nullable: true,
    });
  });

  it('экземпляр хранит значения', () => {
    const entity = new BestMemePostEntity();
    entity.sourceMessageId = 42;
    entity.bestChannelMessageId = 100;
    expect(entity).toMatchObject({ sourceMessageId: 42, bestChannelMessageId: 100 });
  });
});
