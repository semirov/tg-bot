import { cleanName, TrollNameRegistry } from './troll-name-registry';

describe('cleanName', () => {
  it('возвращает null для пустых значений', () => {
    expect(cleanName()).toBeNull();
    expect(cleanName(null)).toBeNull();
    expect(cleanName('')).toBeNull();
  });

  it('схлопывает переносы строк в пробел и обрезает', () => {
    expect(cleanName('Вася\nПупкин')).toBe('Вася Пупкин');
    expect(cleanName('  Вася \n')).toBe('Вася');
  });

  it('возвращает null, если после очистки ничего не осталось', () => {
    expect(cleanName('\n\n')).toBeNull();
  });
});

describe('TrollNameRegistry', () => {
  it('trackName игнорирует отсутствие пользователя или имени', () => {
    const registry = new TrollNameRegistry();

    registry.trackName(1, undefined, 'Вася');
    registry.trackName(1, null, 'Вася');
    registry.trackName(1, 42, null);
    registry.trackName(1, 42, '');

    expect(registry.restoreNames(1, 'вася')).toBe('вася');
  });

  it('restoreNames возвращает текст, если чат неизвестен или текст пуст', () => {
    const registry = new TrollNameRegistry();

    expect(registry.restoreNames(999, 'вася')).toBe('вася');
    expect(registry.restoreNames(1, '')).toBe('');
  });

  it('восстанавливает полное имя, короткое имя и убирает @username', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, 'Вася Пупкин (@vasya)');

    expect(registry.restoreNames(1, 'вася куда')).toBe('Вася куда');
    expect(registry.restoreNames(1, 'вася пришёл')).toBe('Вася пришёл');
    expect(registry.restoreNames(1, 'вася пупкин пришёл')).toBe('Вася Пупкин пришёл');
  });

  it('не считает короткий первый слог кандидатом', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, 'Я Пупкин (@ya)');

    expect(registry.restoreNames(1, 'я тут')).toBe('я тут');
    expect(registry.restoreNames(1, 'пупкин тут')).toBe('пупкин тут');
  });

  it('игнорирует запись, состоящую только из @username', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, '(@vasya)');

    expect(registry.restoreNames(1, 'вася')).toBe('вася');
  });

  it('экранирует спецсимволы регулярного выражения в имени', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, 'А.Б. (x)');

    expect(registry.restoreNames(1, 'а.б. привет')).toBe('А.Б. привет');
  });

  it('перезаписывает имя пользователя при повторном trackName', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, 'Вася');
    registry.trackName(1, 42, 'Петя');

    expect(registry.restoreNames(1, 'вася петя')).toBe('вася Петя');
  });

  it('cleanName доступен как метод', () => {
    const registry = new TrollNameRegistry();

    expect(registry.cleanName('Вася\nПупкин')).toBe('Вася Пупкин');
    expect(registry.cleanName(null)).toBeNull();
  });
});
