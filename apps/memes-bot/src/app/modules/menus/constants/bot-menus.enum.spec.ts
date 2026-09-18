import { AdminMenusEnum, ModeratorMenusEnum, UserMenusEnum } from './bot-menus.enum';

describe('bot-menus.enum', () => {
  it('идентификаторы меню — стабильные строки, используемые при навигации', () => {
    expect(AdminMenusEnum.ADMIN_START_MENU).toBe('ADMIN_START_MENU');
    expect(AdminMenusEnum.TROLL_SETTINGS_MENU).toBe('TROLL_SETTINGS_MENU');
    expect(AdminMenusEnum.TROLL_CHATS_MENU).toBe('TROLL_CHATS_MENU');
    expect(ModeratorMenusEnum.MODERATOR_START_MENU).toBe('MODERATOR_START_MENU');
    expect(UserMenusEnum.USER_START_MENU).toBe('USER_START_MENU');
  });
});
