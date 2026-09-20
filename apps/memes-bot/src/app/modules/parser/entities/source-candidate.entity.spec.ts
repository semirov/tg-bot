import { getMetadataArgsStorage } from 'typeorm';
import { SourceCandidateEntity } from './source-candidate.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === SourceCandidateEntity && item.propertyName === propertyName
  );
}

describe('SourceCandidateEntity', () => {
  it('key — уникальный', () => {
    const index = getMetadataArgsStorage().indices.find(
      (item) => item.target === SourceCandidateEntity && item.name === 'ux_source_candidate_key'
    );
    expect(index?.unique).toBe(true);
    expect(index?.columns).toEqual(['key']);
  });

  it('mentions и verdict имеют дефолты', () => {
    expect(column('mentions')?.options).toMatchObject({ default: 1 });
    expect(column('verdict')?.options).toMatchObject({ default: 'pending' });
    expect(column('origin')?.options).toMatchObject({ default: 'cross_link' });
  });

  it('экземпляр хранит значения', () => {
    const entity = new SourceCandidateEntity();
    entity.key = 'u:memes';
    entity.mentions = 5;
    expect(entity).toMatchObject({ key: 'u:memes', mentions: 5 });
  });
});
