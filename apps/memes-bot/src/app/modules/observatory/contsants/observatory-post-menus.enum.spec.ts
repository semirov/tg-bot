import { ObservatoryPostMenusEnum } from './observatory-post-menus.enum';

describe('ObservatoryPostMenusEnum', () => {
  it('содержит идентификаторы кнопок меню обсерватории', () => {
    expect(ObservatoryPostMenusEnum).toEqual({
      POST_MENU: 'observer_post_menu',
      DELETE_OBSERVER_POST: 'OBS_DELETE_POST',
      OBSERVATORY_PUBLICATION: 'OBSERVATORY_PUBLICATION',
      USER_MODERATE_POST: 'USER_MODERATE_POST',
    });
  });

  it('значения уникальны', () => {
    const values = Object.values(ObservatoryPostMenusEnum);
    expect(new Set(values).size).toBe(values.length);
  });
});
