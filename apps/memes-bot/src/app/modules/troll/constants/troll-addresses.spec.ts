import { isAddressedToBot, isCapabilityQuestion, isNamedCall } from './troll-addresses';

describe('isAddressedToBot', () => {
  it.each([
    'бот, ты чё такой умный',
    'ну ты и пидор',
    'пес, иди сюда',
    'ты хуесос',
    'мудак какой-то',
    'да это же хуйня полная',
  ])('считает обращением: «%s»', (text) => {
    expect(isAddressedToBot(text)).toBe(true);
  });

  it('не ловит обычные слова, в которых просто есть буквы ругательства', () => {
    // «кал» был стемом и ловил кальян — из-за этого бот отвечал на каждую
    // реплику про кальян и забивал чат.
    expect(isAddressedToBot('мы вчера попробовали кальян на электронной чаше')).toBe(false);
    expect(isAddressedToBot('считаю калории, готовлю к лету')).toBe(false);
    expect(isAddressedToBot('купил новые калоши')).toBe(false);
    expect(isAddressedToBot('принёс песок для кота')).toBe(false);
    expect(isAddressedToBot('слушаю песню про кота')).toBe(false);
  });

  it('всё ещё ловит «кал» как отдельное слово', () => {
    expect(isAddressedToBot('ты кал')).toBe(true);
  });
});

describe('isNamedCall — прямые обращения по имени', () => {
  it.each(['бот', 'робот', 'чатбот', 'ии', 'бот, скинь мем', 'а бот тут?'])(
    'видит имя бота в «%s»',
    (text) => {
      expect(isNamedCall(text)).toBe(true);
    }
  );

  it.each(['да это же хуйня полная', 'кальян на электронной чаше', 'ты мудак', 'привет)'])(
    'не считает прямым обращением: «%s»',
    (text) => {
      expect(isNamedCall(text)).toBe(false);
    }
  );
});

describe('isCapabilityQuestion', () => {
  it('ловит вопрос о возможностях и не мешает остальному', () => {
    expect(isCapabilityQuestion('что ты умеешь?')).toBe(true);
    expect(isCapabilityQuestion('мы говорили про кальян')).toBe(false);
  });
});
