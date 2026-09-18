import { getMetadataArgsStorage } from 'typeorm';
import { PublicationModesEnum } from '../../post-management/constants/publication-modes.enum';
import { UserEntity } from './user.entity';
import { PostSchedulerEntity } from './post-scheduler.entity';

describe('PostSchedulerEntity', () => {
  it('хранит параметры отложенной публикации', () => {
    const entity = new PostSchedulerEntity();
    const moderator = new UserEntity();
    const publishDate = new Date('2026-09-19T18:00:00.000Z');
    const createdAt = new Date('2026-09-18T10:00:00.000Z');

    Object.assign(entity, {
      id: 1,
      requestChannelMessageId: 100,
      processedByModerator: moderator,
      publishDate,
      mode: PublicationModesEnum.NEXT_EVENING,
      caption: 'подпись',
      isUserPost: true,
      isPublished: true,
      createdAt,
      hash: 'abc123',
    });

    expect(entity).toMatchObject({
      id: 1,
      requestChannelMessageId: 100,
      mode: PublicationModesEnum.NEXT_EVENING,
      caption: 'подпись',
      isUserPost: true,
      isPublished: true,
      hash: 'abc123',
    });
    expect(entity.processedByModerator).toBe(moderator);
    expect(entity.publishDate).toBe(publishDate);
    expect(entity.createdAt).toBe(createdAt);
  });

  it('допускает пустые необязательные поля', () => {
    const entity = new PostSchedulerEntity();

    expect(entity.caption).toBeUndefined();
    expect(entity.hash).toBeUndefined();
    expect(entity.mode).toBeUndefined();
    expect(entity.publishDate).toBeUndefined();
  });

  it('фабрика связи модератора указывает на UserEntity', () => {
    const relation = getMetadataArgsStorage().relations.find(
      (item) => item.target === PostSchedulerEntity && item.propertyName === 'processedByModerator'
    );

    expect((relation!.type as () => unknown)()).toBe(UserEntity);
    expect((relation!.inverseSideProperty as (value: unknown) => unknown)({ id: 99 })).toBe(99);
  });
});
