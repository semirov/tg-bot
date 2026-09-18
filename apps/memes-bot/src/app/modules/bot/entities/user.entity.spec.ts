import { getMetadataArgsStorage } from 'typeorm';
import { ObservatoryPostEntity } from '../../observatory/entities/observatory-post.entity';
import { UserRequestEntity } from './user-request.entity';
import { UserEntity } from './user.entity';

describe('UserEntity', () => {
  it('хранит профиль, права и счётчики пользователя', () => {
    const entity = new UserEntity();
    const now = new Date('2026-09-18T10:00:00.000Z');
    const until = new Date('2026-09-19T10:00:00.000Z');

    Object.assign(entity, {
      id: 555,
      username: 'vasya',
      firstName: 'Вася',
      lastName: 'Пупкин',
      isBot: false,
      lastActivity: now,
      strikes: 2,
      isBanned: true,
      bannedBy: 1,
      banUntilTo: until,
      isModerator: true,
      allowPublishToChannel: true,
      allowDeleteRejectedPost: true,
      allowRestoreDiscardedPost: true,
      allowSetStrike: true,
      allowMakeBan: true,
      createdAt: now,
      canBeModeratePosts: false,
      memeLimitDisabledUntil: until,
    });

    expect(entity).toMatchObject({
      id: 555,
      username: 'vasya',
      firstName: 'Вася',
      lastName: 'Пупкин',
      isBot: false,
      strikes: 2,
      isBanned: true,
      bannedBy: 1,
      isModerator: true,
      allowPublishToChannel: true,
      allowDeleteRejectedPost: true,
      allowRestoreDiscardedPost: true,
      allowSetStrike: true,
      allowMakeBan: true,
      canBeModeratePosts: false,
    });
    expect(entity.lastActivity).toBe(now);
    expect(entity.banUntilTo).toBe(until);
    expect(entity.createdAt).toBe(now);
    expect(entity.memeLimitDisabledUntil).toBe(until);
  });

  it('по умолчанию необязательные связи не заполнены', () => {
    const entity = new UserEntity();

    expect(entity.postRequests).toBeUndefined();
    expect(entity.moderatedUserRequests).toBeUndefined();
    expect(entity.moderatedObservatoryPosts).toBeUndefined();
  });

  it('связывает пользователя с его заявками и заявками, которые он модерировал', () => {
    const entity = new UserEntity();
    const request = new UserRequestEntity();
    const post = new ObservatoryPostEntity();

    entity.postRequests = [request];
    entity.moderatedUserRequests = [request];
    entity.moderatedObservatoryPosts = [post];

    expect(entity.postRequests).toContain(request);
    expect(entity.moderatedUserRequests).toContain(request);
    expect(entity.moderatedObservatoryPosts).toContain(post);
  });

  it('фабрики связей указывают на правильные сущности', () => {
    const relations = getMetadataArgsStorage().relations.filter(
      (relation) => relation.target === UserEntity
    );
    const byName = Object.fromEntries(relations.map((relation) => [relation.propertyName, relation]));

    expect((byName['postRequests'].type as () => unknown)()).toBe(UserRequestEntity);
    expect((byName['moderatedUserRequests'].type as () => unknown)()).toBe(UserRequestEntity);
    expect((byName['moderatedObservatoryPosts'].type as () => unknown)()).toBe(ObservatoryPostEntity);

    for (const relation of relations) {
      if (typeof relation.inverseSideProperty === 'function') {
        expect(relation.inverseSideProperty({} as any)).toBeUndefined();
      }
    }
  });
});
