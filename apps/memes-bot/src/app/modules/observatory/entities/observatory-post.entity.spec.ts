import { getMetadataArgsStorage } from 'typeorm';
import { ObservatoryPostEntity } from './observatory-post.entity';
import { UserEntity } from '../../bot/entities/user.entity';

function column(propertyName: string) {
  return getMetadataArgsStorage().columns.find(
    (item) => item.target === ObservatoryPostEntity && item.propertyName === propertyName
  );
}

describe('ObservatoryPostEntity', () => {
  it('описывает nullable bigint-поля', () => {
    expect(column('requestChannelMessageId')?.options).toMatchObject({
      type: 'bigint',
      nullable: true,
    });
    expect(column('publishedMessageId')?.options).toMatchObject({
      type: 'bigint',
      nullable: true,
    });
  });

  it('isApproved — nullable bool', () => {
    expect(column('isApproved')?.options).toMatchObject({ type: 'bool', nullable: true });
  });

  it('processedByModerator — связь ManyToOne с UserEntity', () => {
    const relation = getMetadataArgsStorage().relations.find(
      (item) =>
        item.target === ObservatoryPostEntity && item.propertyName === 'processedByModerator'
    );
    expect(relation?.relationType).toBe('many-to-one');
    expect((relation?.type as any)()).toBe(UserEntity);

    const inverse = relation?.inverseSideProperty as (user: UserEntity) => unknown;
    const user = { moderatedObservatoryPosts: ['post'] } as unknown as UserEntity;
    expect(inverse(user)).toBe(user.moderatedObservatoryPosts);
  });

  it('экземпляр хранит значения и связь с пользователем', () => {
    const entity = new ObservatoryPostEntity();
    const moderator = { id: 7 } as UserEntity;
    entity.id = 1;
    entity.requestChannelMessageId = 100;
    entity.publishedMessageId = 200;
    entity.isApproved = true;
    entity.processedByModerator = moderator;

    expect(entity).toMatchObject({
      id: 1,
      requestChannelMessageId: 100,
      publishedMessageId: 200,
      isApproved: true,
    });
    expect(entity.processedByModerator).toBe(moderator);
  });
});
