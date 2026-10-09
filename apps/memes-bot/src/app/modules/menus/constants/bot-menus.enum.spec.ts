import { AdminMenusEnum, ModeratorMenusEnum, UserMenusEnum } from './bot-menus.enum';

describe('bot-menus.enum', () => {
  it('идентификаторы меню — стабильные строки, используемые при навигации', () => {
    expect(AdminMenusEnum.ADMIN_START_MENU).toBe('ADMIN_START_MENU');
    expect(AdminMenusEnum.PARSER_SETTINGS_MENU).toBe('PARSER_SETTINGS_MENU');
    expect(ModeratorMenusEnum.MODERATOR_START_MENU).toBe('MODERATOR_START_MENU');
    expect(UserMenusEnum.USER_START_MENU).toBe('USER_START_MENU');
  });
});
