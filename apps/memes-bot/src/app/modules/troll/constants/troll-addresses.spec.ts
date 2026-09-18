import { isAddressedToBot, isCapabilityQuestion, isNamedCall } from './troll-addresses';

describe('isAddressedToBot', () => {
  it.each([
    'бот, ты чё такой умный',
    'ну ты и пидор',
    'пес, иди сюда',
    'ты хуесос',
    'мудак какой-то',
    'долбоёб, ты чё',
    'ты кал',
    'козлы, хватит',
  ])('считает обращением: «%s»', (text) => {
    expect(isAddressedToBot(text)).toBe(true);
  });

  it('НЕ считает обращением родовую матерщину — которой в чате ругаются просто так', () => {
    expect(isAddressedToBot('да это же хуйня полная')).toBe(false);
    expect(isAddressedToBot('какой-то ебаный интернет')).toBe(false);
    expect(isAddressedToBot('говно полное, всё упало')).toBe(false);
    expect(isAddressedToBot('опять срань какая-то')).toBe(false);
    expect(isAddressedToBot('дерьмо, а не погода')).toBe(false);
  });

  it('не ловит обычные слова, в которых просто есть буквы ругательства', () => {
    // «кал» был стемом и ловил кальян — из-за этого бот отвечал на каждую
    // реплику про кальян и забивал чат.
    expect(isAddressedToBot('мы вчера попробовали кальян на электронной чаше')).toBe(false);
    expect(isAddressedToBot('считаю калории, готовлю к лету')).toBe(false);
    expect(isAddressedToBot('купил новые калоши')).toBe(false);
    expect(isAddressedToBot('принёс песок для кота')).toBe(false);
    expect(isAddressedToBot('слушаю песню про кота')).toBe(false);
    expect(isAddressedToBot('купила баранки к чаю')).toBe(false);
    expect(isAddressedToBot('кончик провода сломался')).toBe(false);
    expect(isAddressedToBot('кухня, тостер и муфельная печка')).toBe(false);
  });

  it('всё ещё ловит «кал», «баран» и «чмо» как отдельные слова', () => {
    expect(isAddressedToBot('ты кал')).toBe(true);
    expect(isAddressedToBot('ну ты баран')).toBe(true);
    expect(isAddressedToBot('чмо')).toBe(true);
    expect(isAddressedToBot('чмошник')).toBe(true);
  });

  it('на пустом вводе возвращает false', () => {
    expect(isAddressedToBot(null)).toBe(false);
    expect(isAddressedToBot(undefined)).toBe(false);
    expect(isAddressedToBot('')).toBe(false);
  });

  it('пропускает пустые слова между разделителями', () => {
    expect(isAddressedToBot('!!!')).toBe(false);
    expect(isAddressedToBot('... бот!')).toBe(true);
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

  it('на пустом вводе возвращает false', () => {
    expect(isNamedCall(null)).toBe(false);
    expect(isNamedCall(undefined)).toBe(false);
    expect(isNamedCall('')).toBe(false);
  });
});

describe('isCapabilityQuestion', () => {
  it('ловит вопрос о возможностях и не мешает остальному', () => {
    expect(isCapabilityQuestion('что ты умеешь?')).toBe(true);
    expect(isCapabilityQuestion('мы говорили про кальян')).toBe(false);
  });

  it('распознаёт разные формулировки вопроса и нормализует ё', () => {
    expect(isCapabilityQuestion('а что ты можешь')).toBe(true);
    expect(isCapabilityQuestion('какие у тебя команды')).toBe(true);
    expect(isCapabilityQuestion('дай список команд')).toBe(true);
    expect(isCapabilityQuestion('как тобой пользоваться')).toBe(true);
    expect(isCapabilityQuestion('/help')).toBe(true);
    expect(isCapabilityQuestion('хэлп')).toBe(false);
    expect(isCapabilityQuestion('хелп')).toBe(true);
  });

  it('на пустом вводе возвращает false', () => {
    expect(isCapabilityQuestion(null)).toBe(false);
    expect(isCapabilityQuestion(undefined)).toBe(false);
    expect(isCapabilityQuestion('')).toBe(false);
  });
});
