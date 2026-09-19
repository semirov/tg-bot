import { ModerationRoundPolicy } from './moderation-round-policy';

describe('ModerationRoundPolicy', () => {
  const policy = new ModerationRoundPolicy();

  describe('decide', () => {
    it('одобряет пост, когда лайков больше', () => {
      expect(policy.decide({ likes: 3, dislikes: 1 })).toEqual({
        isApproved: true,
        userResultLabel: 'Пост будет опубликован 👍 3   👎 1',
      });
    });

    it('одобряет пост без голосов и не добавляет счётчики', () => {
      expect(policy.decide({ likes: 0, dislikes: 0 })).toEqual({
        isApproved: true,
        userResultLabel: 'Пост будет опубликован',
      });
    });

    it('одобряет пост только с лайками', () => {
      expect(policy.decide({ likes: 2, dislikes: 0 }).userResultLabel).toBe(
        'Пост будет опубликован 👍 2'
      );
    });

    it('одобряет при равенстве голосов', () => {
      expect(policy.decide({ likes: 2, dislikes: 2 }).isApproved).toBe(true);
    });

    it('отклоняет пост, когда дизлайков больше', () => {
      expect(policy.decide({ likes: 1, dislikes: 5 })).toEqual({
        isApproved: false,
        userResultLabel: 'Пост не будет опубликован 👍 1   👎 5',
      });
    });

    it('отклоняет пост только с дизлайками', () => {
      expect(policy.decide({ likes: 0, dislikes: 4 }).userResultLabel).toBe(
        'Пост не будет опубликован   👎 4'
      );
    });
  });

  describe('buildUserResultLabel', () => {
    it('склеивает непустые части счётчиков', () => {
      expect(policy.buildUserResultLabel(true, { likes: 1, dislikes: 2 })).toBe(
        'Пост будет опубликован 👍 1   👎 2'
      );
      expect(policy.buildUserResultLabel(false, { likes: 0, dislikes: 0 })).toBe(
        'Пост не будет опубликован'
      );
    });
  });

  describe('buildUserResultKeyboard', () => {
    it('строит клавиатуру из одной кнопки с текстом итога', () => {
      const keyboard = policy.buildUserResultKeyboard({
        isApproved: true,
        userResultLabel: 'Пост будет опубликован',
      });

      expect(keyboard.inline_keyboard[0][0].text).toBe('Пост будет опубликован');
    });
  });
});
