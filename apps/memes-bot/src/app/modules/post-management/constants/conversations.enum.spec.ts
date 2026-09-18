import { ConversationsEnum } from './conversations.enum';

describe('ConversationsEnum', () => {
  it('хранит строковые id диалогов, используемые для регистрации', () => {
    // Значения важны: createConversation и conversation.enter сверяют их по строке.
    expect(ConversationsEnum.ADD_MODERATOR_CONVERSATION).toBe('ADD_MODERATOR_CONVERSATION');
    expect(ConversationsEnum.ADMIN_USER_CONVERSATION).toBe('ADMIN_USER_CONVERSATION');
  });

  it('ключи и значения совпадают (нет опечаток)', () => {
    expect(Object.keys(ConversationsEnum)).toEqual([
      'ADD_MODERATOR_CONVERSATION',
      'ADMIN_USER_CONVERSATION',
    ]);
  });
});
