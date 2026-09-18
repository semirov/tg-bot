import { getMetadataArgsStorage } from 'typeorm';
import { UserMessageModeratedPostEntity } from './user-message-moderated-post.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === UserMessageModeratedPostEntity && item.propertyName === propertyName
  );
}

describe('UserMessageModeratedPostEntity', () => {
  it('bigint-поля nullable, счётчик обращений по умолчанию 0', () => {
    expect(column('userId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('userMessageId')?.options).toMatchObject({ type: 'bigint', nullable: true });
    expect(column('requestChannelMessageId')?.options).toMatchObject({
      type: 'bigint',
      default: 0,
    });
  });

  it('voted — boolean по умолчанию false', () => {
    expect(column('voted')?.options).toMatchObject({ type: 'boolean', default: false });
  });

  it('экземпляр хранит значения голосования', () => {
    const entity = new UserMessageModeratedPostEntity();
    entity.id = 3;
    entity.userId = 42;
    entity.userMessageId = 43;
    entity.requestChannelMessageId = 44;
    entity.voted = true;

    expect(entity).toMatchObject({
      id: 3,
      userId: 42,
      userMessageId: 43,
      requestChannelMessageId: 44,
      voted: true,
    });
  });
});
