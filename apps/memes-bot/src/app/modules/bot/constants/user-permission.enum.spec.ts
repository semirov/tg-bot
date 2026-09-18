import { UserPermissionEnum } from './user-permission.enum';

describe('UserPermissionEnum', () => {
  it('содержит ровно шесть известных прав', () => {
    expect(Object.keys(UserPermissionEnum)).toHaveLength(6);
  });

  it.each([
    ['IS_BASE_MODERATOR', 'IS_BASE_MODERATOR'],
    ['ALLOW_PUBLISH_TO_CHANNEL', 'ALLOW_PUBLISH_TO_CHANNEL'],
    ['ALLOW_DELETE_REJECTED_POST', 'ALLOW_DELETE_REJECTED_POST'],
    ['ALLOW_RESTORE_DISCARDED_POST', 'ALLOW_RESTORE_DISCARDED_POST'],
    ['ALLOW_SET_STRIKE', 'ALLOW_SET_STRIKE'],
    ['ALLOW_MAKE_BAN', 'ALLOW_MAKE_BAN'],
  ])('значение %s совпадает со строкой %s', (key, value) => {
    expect(UserPermissionEnum[key as keyof typeof UserPermissionEnum]).toBe(value);
    expect(UserPermissionEnum[value as any]).toBe(key);
  });
});
