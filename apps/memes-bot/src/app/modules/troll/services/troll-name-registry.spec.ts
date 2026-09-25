import { cleanName, extractFirstName, restoreNameCase, TrollNameRegistry } from './troll-name-registry';

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

describe('extractFirstName', () => {
  it('вытаскивает первое слово и убирает @username', () => {
    expect(extractFirstName('Konstantin Khimenkov (@khimenkov)')).toBe('Konstantin');
    expect(extractFirstName('Nastia (@no_lamas)')).toBe('Nastia');
    expect(extractFirstName('Андрей Соколов [Авто.ру] (@sokolov2049)')).toBe('Андрей');
  });

  it('приводит первую букву к верхнему регистру', () => {
    expect(extractFirstName('вася пупкин (@vasya)')).toBe('Вася');
    expect(extractFirstName('konstantin khimenkov')).toBe('Konstantin');
  });

  it('возвращает null для пустого, ника или слишком короткого', () => {
    expect(extractFirstName('(@vasya)')).toBeNull();
    expect(extractFirstName(null)).toBeNull();
    expect(extractFirstName(undefined)).toBeNull();
    expect(extractFirstName('Я')).toBeNull();
    expect(extractFirstName('   ')).toBeNull();
  });
});

describe('restoreNameCase', () => {
  it('возвращает имени регистр в тексте', () => {
    expect(restoreNameCase('нарекаю вася - подмыхан', 'Вася Пупкин (@vasya)')).toBe(
      'нарекаю Вася - подмыхан'
    );
  });

  it('не трогает текст без имени', () => {
    expect(restoreNameCase('всем привет', 'Вася Пупкин (@vasya)')).toBe('всем привет');
  });

  it('пустой текст и пустое имя возвращаются как есть', () => {
    expect(restoreNameCase('', 'Вася Пупкин (@vasya)')).toBe('');
    expect(restoreNameCase('привет', '(@onlynick)')).toBe('привет');
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

  it('firstName возвращает чистое имя с большой буквы', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, 'Konstantin Khimenkov (@khimenkov)');

    expect(registry.firstName(1, 42)).toBe('Konstantin');
    expect(registry.firstName(1, 999)).toBeNull();
    expect(registry.firstName(1)).toBeNull();
    expect(registry.firstName(999, 42)).toBeNull();
  });

  it('restoreNames использует каноническое имя даже для строчного отображаемого', () => {
    const registry = new TrollNameRegistry();
    registry.trackName(1, 42, 'konstantin khimenkov (@khimenkov)');

    expect(registry.restoreNames(1, 'konstantin куда')).toBe('Konstantin куда');
  });
});
