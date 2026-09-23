import {
  TROLL_MEMBER_BIO_DROP_THRESHOLD,
  TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS,
  TROLL_MEMBER_BIO_HALF_LIFE_MAX_HOURS,
  TROLL_MEMBER_BIO_WEIGHT_BOOST,
  TROLL_MEMBER_BIO_WEIGHT_INITIAL,
  TROLL_MEMBER_BIO_WEIGHT_MAX,
} from '../constants/troll-limits';
import { TrollMemberBioFact } from '../entities/troll-member-bio.entity';
import {
  decayOnly,
  decayedWeight,
  factSimilarity,
  factTokens,
  findBioLeak,
  halfLifeHours,
  looksLikePii,
  looksLikeTopicNotBiography,
  evidenceLooksCopied,
  mergeFacts,
  normalizeFact,
  renderBioText,
} from './troll-bio';

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function fact(over: Partial<TrollMemberBioFact> = {}): TrollMemberBioFact {
  return {
    text: 'Живёт в Санкт-Петербурге',
    importance: 3,
    count: 1,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    baseWeight: TROLL_MEMBER_BIO_WEIGHT_INITIAL,
    weight: TROLL_MEMBER_BIO_WEIGHT_INITIAL,
    ...over,
  };
}

describe('troll-bio', () => {
  describe('normalizeFact / factTokens', () => {
    it('приводит регистр, ё и пунктуацию', () => {
      expect(normalizeFact('  ЁЖИК, «дом»!  ')).toBe('ежик дом');
    });

    it('токены короче 3 символов отбрасываются', () => {
      expect(factTokens('он и она дом')).toEqual(['она', 'дом']);
    });
  });

  describe('factSimilarity', () => {
    it('похожие факты дают высокий скор', () => {
      expect(factSimilarity('Живёт в Санкт-Петербурге', 'живет в санкт петербурге')).toBeGreaterThan(0.6);
    });

    it('разные факты не совпадают', () => {
      expect(factSimilarity('Живёт в Санкт-Петербурге', 'Программирует арбитражных ботов')).toBe(0);
    });

    it('короткие факты (меньше двух слов) не сравниваются', () => {
      expect(factSimilarity('VPN', 'VPN')).toBe(0);
    });
  });

  describe('looksLikeTopicNotBiography', () => {
    it.each([
      'Обсуждает аренду жилья и залоги',
      'Интересуется базами ФССП',
      'Упоминает аквариумы',
      'Имеет знакомого, работающего в Яндексе',
      'Друг посоветовал сервис',
      'Цитирует журнал «Регионы России»',
      'Смеялся над историей про сосульку',
      'Участвовал в историях про говно',
      'Посмотрел сериал',
    ])('отсеивает не-биографию: %s', (text) => {
      expect(looksLikeTopicNotBiography(text)).toBe(true);
    });

    it.each([
      'Живёт в Санкт-Петербурге',
      'Программирует арбитражных ботов',
      'Работала у дистрибьютора',
    ])('пропускает личные факты: %s', (text) => {
      expect(looksLikeTopicNotBiography(text)).toBe(false);
    });
  });

  describe('evidenceLooksCopied', () => {
    it('коллективное «мы» без личного «я» — чужой текст', () => {
      expect(evidenceLooksCopied('Наша IT компания создала первую блокчейн-платформу')).toBe(true);
      expect(evidenceLooksCopied('мы с коллегами поздравляем')).toBe(true);
    });

    it('личное высказывание принимается', () => {
      expect(evidenceLooksCopied('не, я же у дистра работала')).toBe(false);
      expect(evidenceLooksCopied('плачу 1к за безлимит')).toBe(false);
    });
  });

  describe('looksLikePii', () => {
    it.each([
      'Дата рождения 14.07.1970',
      'госномер С418ХК99',
      'телефон +7 999 123-45-67',
      'паспорт 4519 123456',
      'ИНН 7707083893',
      'СНИЛС 123-456-789 00',
      'адрес: ул. Гризодубовой, дом 4, кв 131',
    ])('ловит PII: %s', (text) => {
      expect(looksLikePii(text)).toBe(true);
    });

    it.each([
      'интересуется инфоцыганами',
      'разбирается в юрлицах',
      'работает в IT',
    ])('не трогает безопасные факты: %s', (text) => {
      expect(looksLikePii(text)).toBe(false);
    });
  });

  describe('halfLifeHours', () => {
    it('растёт с важностью и подтверждениями, но ограничен потолком', () => {
      expect(halfLifeHours({ importance: 1, count: 1 })).toBe(TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS);
      expect(halfLifeHours({ importance: 3, count: 1 })).toBe(3 * TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS);
      expect(halfLifeHours({ importance: 5, count: 30 })).toBe(TROLL_MEMBER_BIO_HALF_LIFE_MAX_HOURS);
      expect(halfLifeHours({ importance: 0, count: 1 })).toBe(TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS);
    });
  });

  describe('decayedWeight', () => {
    it('за период полураспада вес делится вдвое', () => {
      const item = fact({ importance: 3, count: 1, baseWeight: 2, lastSeenAt: NOW });
      const hl = halfLifeHours(item);
      expect(decayedWeight(item, NOW + hl * HOUR_MS)).toBeCloseTo(1, 5);
    });

    it('без времени распада вес равен базовому', () => {
      const item = fact({ baseWeight: 2 });
      expect(decayedWeight(item, NOW)).toBe(2);
    });
  });

  describe('mergeFacts', () => {
    it('новые факты добавляются, похожие подтверждаются', () => {
      const existing = [fact({ count: 1 })];
      const result = mergeFacts(
        existing,
        [
          { text: 'живет в санкт петербурге', importance: 4 },
          { text: 'Программирует арбитражных ботов', importance: 5 },
        ],
        NOW
      );
      expect(result.added).toBe(1);
      expect(result.promoted).toBe(1);
      expect(result.facts).toHaveLength(2);
      const spb = result.facts.find((item) => item.text.includes('Петербург'))!;
      expect(spb.count).toBe(2);
      expect(spb.baseWeight).toBe(Math.min(TROLL_MEMBER_BIO_WEIGHT_MAX, 1 + TROLL_MEMBER_BIO_WEIGHT_BOOST));
    });

    it('повторное подтверждение уже ядрового факта не считается новым ядром', () => {
      const existing = [fact({ count: 2 })];
      const result = mergeFacts(existing, [{ text: 'Живёт в Санкт-Петербурге', importance: 3 }], NOW);
      expect(result.promoted).toBe(0);
      expect(result.facts[0].count).toBe(3);
    });

    it('важность факта не понижается подтверждением', () => {
      const existing = [fact({ count: 1, importance: 5 })];
      const result = mergeFacts(existing, [{ text: 'Живёт в Санкт-Петербурге', importance: 1 }], NOW);
      expect(result.facts[0].importance).toBe(5);
    });

    it('не разгоняет вес выше потолка', () => {
      const existing = [fact({ count: 1, baseWeight: TROLL_MEMBER_BIO_WEIGHT_MAX })];
      const result = mergeFacts(existing, [{ text: 'Живёт в Санкт-Петербурге', importance: 3 }], NOW);
      expect(result.facts[0].baseWeight).toBe(TROLL_MEMBER_BIO_WEIGHT_MAX);
    });

    it('клампы важности: вне диапазона приводится к 1..5', () => {
      const existing = [fact({ count: 1, importance: 2 })];
      const result = mergeFacts(
        existing,
        [
          { text: 'Живёт в Санкт-Петербурге', importance: 9 },
          { text: 'Совсем новый факт', importance: 0 },
        ],
        NOW
      );
      const spb = result.facts.find((item) => item.text.includes('Петербург'))!;
      expect(spb.importance).toBe(5);
      const fresh = result.facts.find((item) => item.text.includes('новый'))!;
      expect(fresh.importance).toBe(1);
    });

    it('вымывает ослабшие факты по порогу', () => {
      const old = fact({
        baseWeight: 1,
        lastSeenAt: NOW - 10_000 * HOUR_MS,
      });
      const result = mergeFacts([old], [], NOW);
      expect(result.facts).toHaveLength(0);
      expect(result.dropped).toBe(1);
    });

    it('отбрасывает темы, третьих лиц и цитаты', () => {
      const result = mergeFacts(
        [],
        [
          { text: 'Обсуждает блокчейн-платформу', importance: 3 },
          { text: 'Имеет знакомого из Яндекса', importance: 3 },
          { text: 'Процитировала журнал «Регионы России»', importance: 3 },
        ],
        NOW
      );
      expect(result.facts).toHaveLength(0);
    });

    it('отбрасывает PII, пустые и слишком короткие факты', () => {
      const result = mergeFacts(
        [],
        [
          { text: 'паспорт 4519 123456', importance: 3 },
          { text: '  ', importance: 3 },
          { text: 'ab', importance: 3 },
        ],
        NOW
      );
      expect(result.facts).toHaveLength(0);
    });
  });

  describe('decayOnly', () => {
    it('считает вес и вымывает ослабшее', () => {
      const fresh = fact({ baseWeight: 1, lastSeenAt: NOW });
      const stale = fact({ baseWeight: 1, lastSeenAt: NOW - 10_000 * HOUR_MS });
      const result = decayOnly([fresh, stale], NOW);
      expect(result.facts).toHaveLength(1);
      expect(result.dropped).toBe(1);
      expect(result.facts[0].weight).toBeGreaterThanOrEqual(TROLL_MEMBER_BIO_DROP_THRESHOLD);
    });
  });

  describe('decayOnly tiebreak', () => {
    it('при равном счётчике сортирует по весу', () => {
      const light = fact({ count: 2, baseWeight: 1, lastSeenAt: NOW });
      const heavy = fact({ count: 2, baseWeight: 4, lastSeenAt: NOW });
      const result = decayOnly([light, heavy], NOW);
      expect(result.facts[0].baseWeight).toBe(4);
    });
  });

  describe('renderBioText', () => {
    it('укладывается в потолок символов', () => {
      const facts = [fact({ text: 'первый' }), fact({ text: 'второй' })];
      expect(renderBioText(facts, 100, NOW)).toBe('- первый\n- второй');
      expect(renderBioText(facts, 10, NOW)).toBe('- первый');
    });

    it('пропускает вымытые и пустые факты, но берёт следующие подходящие', () => {
      const stale = fact({ text: 'старое', lastSeenAt: NOW - 10_000 * HOUR_MS });
      const empty = fact({ text: '<>' });
      const big = fact({ text: 'б'.repeat(50) });
      const small = fact({ text: 'мелкий' });
      expect(renderBioText([stale, empty, big, small], 20, NOW)).toBe('- мелкий');
    });
  });

  describe('findBioLeak', () => {
    it('ловит canary', () => {
      expect(findBioLeak('ну и ВНУТР_БИО_7F3A9E21 тебе', [], 'ВНУТР_БИО_7F3A9E21')).toBe(true);
    });

    it('ловит дословный фрагмент факта', () => {
      expect(
        findBioLeak(
          'он разбирается в арбитражных делах и долгах компаний, вот так',
          ['Разбирается в арбитражных делах и долгах компаний'],
          ''
        )
      ).toBe(true);
    });

    it('игнорирует пустые факты', () => {
      expect(findBioLeak('любой текст тут есть', ['   '], '')).toBe(false);
    });
    it('не срабатывает на свободный ответ', () => {
      expect(findBioLeak('иди отсюда, тролль', ['Живёт в Санкт-Петербурге'], '')).toBe(false);
    });
  });
});
