import { getMetadataArgsStorage } from 'typeorm';
import { UserEntity } from './user.entity';
import { UserRequestEntity } from './user-request.entity';

describe('UserRequestEntity', () => {
  it('хранит все поля заявки и обе связи с пользователем', () => {
    const entity = new UserRequestEntity();
    const user = new UserEntity();
    const moderator = new UserEntity();
    const moderatedAt = new Date('2026-09-18T10:00:00.000Z');
    const publishedAt = new Date('2026-09-18T11:00:00.000Z');
    const createdAt = new Date('2026-09-18T09:00:00.000Z');

    Object.assign(entity, {
      id: '42',
      user,
      isAnonymousPublishing: true,
      originalMessageId: 1,
      userRequestChannelMessageId: 2,
      possibleDuplicate: true,
      isDuplicate: true,
      checkedByModerator: 3,
      isApproved: false,
      processedByModerator: moderator,
      moderatedAt,
      fileUniqueId: 'file-id',
      restoredBy: 4,
      isPublished: true,
      publishedAt,
      publishedBy: 5,
      publishedMessageId: 6,
      createdAt,
      isTextRequest: false,
      replyToMessageId: 7,
      scheduledDuplicateId: 8,
    });

    expect(entity).toMatchObject({
      id: '42',
      isAnonymousPublishing: true,
      originalMessageId: 1,
      userRequestChannelMessageId: 2,
      possibleDuplicate: true,
      isDuplicate: true,
      checkedByModerator: 3,
      isApproved: false,
      fileUniqueId: 'file-id',
      restoredBy: 4,
      isPublished: true,
      publishedBy: 5,
      publishedMessageId: 6,
      isTextRequest: false,
      replyToMessageId: 7,
      scheduledDuplicateId: 8,
    });
    expect(entity.user).toBe(user);
    expect(entity.processedByModerator).toBe(moderator);
    expect(entity.moderatedAt).toBe(moderatedAt);
    expect(entity.publishedAt).toBe(publishedAt);
    expect(entity.createdAt).toBe(createdAt);
  });

  it('фабрики связей ссылаются на UserEntity в обе стороны', () => {
    const relations = getMetadataArgsStorage().relations.filter(
      (relation) => relation.target === UserRequestEntity
    );
    const byName = Object.fromEntries(relations.map((relation) => [relation.propertyName, relation]));

    expect((byName['user'].type as () => unknown)()).toBe(UserEntity);
    expect((byName['processedByModerator'].type as () => unknown)()).toBe(UserEntity);
    expect(relationProperty(byName['user'], 'postRequests')).toBe('postRequests');
    expect(relationProperty(byName['processedByModerator'], 'moderatedUserRequests')).toBe(
      'moderatedUserRequests'
    );
  });
});

function relationProperty(relation: { inverseSideProperty?: any }, key: string): string | undefined {
  if (typeof relation.inverseSideProperty !== 'function') {
    return undefined;
  }
  return relation.inverseSideProperty({ [key]: key });
}
