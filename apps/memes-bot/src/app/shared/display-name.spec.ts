import { formatUserName } from './display-name';

describe('formatUserName', () => {
  it('возвращает @username, если он задан', () => {
    expect(formatUserName({ username: 'vasya' })).toBe('@vasya');
  });

  it('предпочитает username имени и фамилии', () => {
    expect(
      formatUserName({ username: 'vasya', firstName: 'Иван', lastName: 'Петров' })
    ).toBe('@vasya');
  });

  it('склеивает имя и фамилию, когда username отсутствует', () => {
    expect(formatUserName({ firstName: 'Иван', lastName: 'Петров' })).toBe('Иван Петров');
  });

  it('возвращает только имя, если фамилии нет', () => {
    expect(formatUserName({ firstName: 'Иван', lastName: null })).toBe('Иван');
  });

  it('возвращает только фамилию, если имени нет', () => {
    expect(formatUserName({ firstName: null, lastName: 'Петров' })).toBe('Петров');
  });

  it('возвращает пустую строку, когда нет данных', () => {
    expect(formatUserName({})).toBe('');
    expect(formatUserName({ username: null, firstName: null, lastName: null })).toBe('');
  });

  it('игнорирует пустой username и пустые части имени', () => {
    expect(formatUserName({ username: '', firstName: 'Пётр', lastName: '' })).toBe('Пётр');
  });

  it('склеивает части имени без лишних пробелов', () => {
    expect(formatUserName({ firstName: 'A', lastName: 'B' })).toBe('A B');
    expect(formatUserName({ firstName: 'A', lastName: '' })).toBe('A');
    expect(formatUserName({ firstName: '', lastName: 'B' })).toBe('B');
  });
});
