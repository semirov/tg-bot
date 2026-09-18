import { PostModerationMenusEnum } from './post-moderation-menus.enum';

describe('PostModerationMenusEnum', () => {
  it('содержит id всех меню модерации', () => {
    expect(PostModerationMenusEnum.MODERATION).toBe('MODERATION');
    expect(PostModerationMenusEnum.APPROVAL).toBe('APPROVAL');
    expect(PostModerationMenusEnum.REJECT).toBe('REJECT');
    expect(PostModerationMenusEnum.PUBLICATION).toBe('PUBLICATION');
    expect(PostModerationMenusEnum.BAN).toBe('BAN');
    expect(PostModerationMenusEnum.STRIKE).toBe('STRIKE');
    expect(PostModerationMenusEnum.DUPLICATE_CHECK).toBe('DUPLICATE_CHECK');
  });

  it('значения уникальны — иначе grammy перепутает кнопки', () => {
    const values = Object.values(PostModerationMenusEnum);
    expect(new Set(values).size).toBe(values.length);
  });
});
