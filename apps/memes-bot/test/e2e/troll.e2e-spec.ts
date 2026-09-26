/**
 * E2E-покрытие тролль-бота: команды в активном чате, онбординг владельца,
 * реакции/сарказм/кривляние по настройкам и разбор дефекта в личке.
 *
 * DeepSeekService подменяется управляемой заглушкой — тест проверяет реакцию
 * бота на ответ модели, а не работу LLM.
 */
import { E2EHarness, createE2EHarness, findCall, groupMessageUpdate, privateMessageUpdate, waitFor } from './harness';
import { DeepSeekService } from '../../src/app/modules/troll/services/deepseek.service';
import { TrollSettingsService } from '../../src/app/modules/troll/services/troll-settings.service';
import { TrollChatEntity } from '../../src/app/modules/troll/entities/troll-chat.entity';
import { TrollDefectEntity } from '../../src/app/modules/troll/entities/troll-defect.entity';
import { TrollMessageEntity } from '../../src/app/modules/troll/entities/troll-message.entity';
import { TrollPredictionEntity } from '../../src/app/modules/troll/entities/troll-prediction.entity';

const OWNER_ID = Number(process.env.BOT_OWNER_ID);

function createDeepSeekStub() {
  return {
    complete: jest.fn(async () => 'ответ модели'),
    completeText: jest.fn(async () => 'текст модели'),
    completeJson: jest.fn(async () => ({}) as unknown),
  };
}

function myChatMemberUpdate(options: {
  chatId: number;
  addedBy?: number;
  oldStatus?: string;
  newStatus?: string;
}): Record<string, any> {
  const user = { id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot' };
  return {
    update_id: 7000,
    my_chat_member: {
      chat: { id: options.chatId, type: 'supergroup', title: 'Troll Chat' },
      from: { id: options.addedBy ?? 555, is_bot: false, first_name: 'Member', username: 'member' },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: options.oldStatus ?? 'left', user },
      new_chat_member: { status: options.newStatus ?? 'member', user },
    },
  };
}

function ownerCallbackUpdate(options: { data: string; ownerId: number }): Record<string, any> {
  return {
    update_id: 8001,
    callback_query: {
      id: 'callback-1',
      from: { id: options.ownerId, is_bot: false, first_name: 'Owner', username: 'owner' },
      chat_instance: 'chat-instance',
      data: options.data,
      message: {
        message_id: 999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: options.ownerId, type: 'private' },
        text: 'Бота добавили в чат — подтверди',
      },
    },
  };
}

describe('E2E: тролль-бот', () => {
  let h: E2EHarness;
  let deepseek: ReturnType<typeof createDeepSeekStub>;
  let settings: TrollSettingsService;

  beforeEach(async () => {
    deepseek = createDeepSeekStub();
    h = await createE2EHarness({
      overrideProviders: [{ provide: DeepSeekService, useValue: deepseek }],
    });
    await h.resetDb();
    settings = h.moduleRef.get(TrollSettingsService);
  });

  afterEach(async () => {
    if (h) {
      await h.close();
    }
  });

  async function seedActiveChat(chatId: number, title = 'Troll Chat'): Promise<void> {
    await h.dataSource.getRepository(TrollChatEntity).save({
      chatId,
      title,
      isActive: true,
      addedByUserId: null,
      lastSummaryAt: null,
    });
  }

  /** Даёт сработать fire-and-forget обработчикам (реакции, сарказм, зеркала). */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

  /** Базовая конфигурация: всё выключено, чтобы тест проверял одну ветку. */
  async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
    await settings.update({
      enabled: true,
      criminalEnabled: false,
      sarcasmEnabled: false,
      sarcasmChance: 1,
      sarcasmCooldownSec: 0,
      mirrorEnabled: false,
      mirrorChance: 1,
      mirrorCooldownSec: 0,
      reactionEnabled: false,
      reactionChance: 1,
      reactionCooldownSec: 0,
      jerkEnabled: false,
      addressReactionEnabled: false,
      selfCheckEnabled: false,
      ...overrides,
    } as any);
  }

  describe('команды в активном чате', () => {
    it('/stat считает срок по истории пользователя', async () => {
      const chatId = -1007000000001;
      const userId = 7001;
      await seedActiveChat(chatId);
      await h.dataSource.getRepository(TrollMessageEntity).save([
        { chatId, userId, userName: 'Вася', role: 'user', content: 'украл мем', messageId: 1, replyToMessageId: null },
        { chatId, userId, userName: 'Вася', role: 'user', content: 'ещё украл', messageId: 2, replyToMessageId: null },
      ]);
      deepseek.completeJson.mockResolvedValue({
        articles: [{ code: '158', title: 'Кража', years: 6, reason: 'украл мем' }],
      });
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId, text: '/stat', messageId: 30 }));

      await waitFor(() => {
        const reply = findCall(
          h.calls,
          'sendMessage',
          (p) => p.chat_id === chatId && String(p.text).includes('потенциальный срок')
        );
        expect(reply).toBeDefined();
        expect(String(reply!.payload.text)).toContain('158');
        expect(String(reply!.payload.text)).toContain('Итого: 6 лет');
      });
    });

    it('/future генерирует предсказание и берёт повтор из кэша', async () => {
      const chatId = -1007000000002;
      const userId = 7002;
      await seedActiveChat(chatId);
      await configure();
      deepseek.completeText.mockResolvedValue('Сегодня тебя ждёт удача');
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId, text: '/future', messageId: 31 }));
      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => p.chat_id === chatId && String(p.text).includes('удача'))
        ).toBeDefined()
      );
      expect(deepseek.completeText).toHaveBeenCalledTimes(1);

      const prediction = await h.dataSource
        .getRepository(TrollPredictionEntity)
        .findOne({ where: { chatId } });
      expect(prediction?.requests).toBe(1);

      // Повторный запрос в пределах 12 часов — из кэша, без нового обращения к LLM.
      await h.sendUpdate(groupMessageUpdate({ chatId, userId, text: '/future', messageId: 32 }));
      await waitFor(async () => {
        const stored = await h.dataSource
          .getRepository(TrollPredictionEntity)
          .findOne({ where: { chatId } });
        expect(stored?.requests).toBe(2);
      });
      expect(deepseek.completeText).toHaveBeenCalledTimes(1);
    });

    it('/sumarize пересказывает переписку и двигает метку окна', async () => {
      const chatId = -1007000000004;
      const userId = 7004;
      await seedActiveChat(chatId);
      await configure();
      await h.dataSource.getRepository(TrollMessageEntity).save({
        chatId,
        userId,
        userName: 'Вася',
        role: 'user',
        content: 'обсуждали мемы',
        messageId: 41,
        replyToMessageId: null,
      });
      deepseek.completeText.mockResolvedValue('обсуждали мемы');
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId, text: '/sumarize', messageId: 34 }));

      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => p.chat_id === chatId && String(p.text).includes('мемы'))
        ).toBeDefined()
      );

      const chat = await h.dataSource.getRepository(TrollChatEntity).findOne({ where: { chatId } });
      expect(chat?.lastSummaryAt).not.toBeNull();
    });
  });

  describe('онбординг чата владельцем', () => {
    it('при добавлении уведомляет владельца, по кнопке активирует чат', async () => {
      const chatId = -1007000000005;
      h.clearCalls();

      await h.sendUpdate(myChatMemberUpdate({ chatId }));
      await waitFor(() =>
        expect(
          findCall(
            h.calls,
            'sendMessage',
            (p) => p.chat_id === OWNER_ID && String(p.text).includes('Бота добавили в чат')
          )
        ).toBeDefined()
      );

      let chat = await h.dataSource.getRepository(TrollChatEntity).findOne({ where: { chatId } });
      expect(chat?.isActive).toBe(false);

      h.clearCalls();
      await h.sendUpdate(ownerCallbackUpdate({ data: `troll:approve:${chatId}`, ownerId: OWNER_ID }));

      await waitFor(() =>
        expect(
          findCall(
            h.calls,
            'sendMessage',
            (p) => p.chat_id === chatId && String(p.text).includes('Всем привет')
          )
        ).toBeDefined()
      );
      expect(findCall(h.calls, 'answerCallbackQuery')).toBeDefined();

      chat = await h.dataSource.getRepository(TrollChatEntity).findOne({ where: { chatId } });
      expect(chat?.isActive).toBe(true);
    });
  });

  describe('реакции / сарказм / кривляние по настройкам', () => {
    it('ставит реакцию, когда reactionEnabled', async () => {
      const chatId = -1007000000006;
      await seedActiveChat(chatId);
      await configure({ reactionEnabled: true });
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId: 7006, text: 'какой-то обычный текст' }));

      await waitFor(() =>
        expect(findCall(h.calls, 'setMessageReaction', (p) => p.chat_id === chatId)).toBeDefined()
      );
    });

    it('не ставит реакцию, когда reactionEnabled выключен', async () => {
      const chatId = -1007000000007;
      await seedActiveChat(chatId);
      await configure({ reactionEnabled: false });
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId: 7007, text: 'какой-то обычный текст' }));
      await settle();

      expect(findCall(h.calls, 'setMessageReaction')).toBeUndefined();
    });

    it('подкалывает, когда sarcasmEnabled', async () => {
      const chatId = -1007000000008;
      await seedActiveChat(chatId);
      await configure({ sarcasmEnabled: true });
      deepseek.complete.mockResolvedValue('саркастичный ответ');
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId: 7008, text: 'длинный текст без обращения' }));

      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => p.chat_id === chatId && String(p.text).includes('саркастичный'))
        ).toBeDefined()
      );
    });

    it('не подкалывает, когда sarcasmEnabled выключен', async () => {
      const chatId = -1007000000009;
      await seedActiveChat(chatId);
      await configure({ sarcasmEnabled: false });
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId: 7009, text: 'длинный текст без обращения' }));
      await settle();

      expect(deepseek.complete).not.toHaveBeenCalled();
      expect(findCall(h.calls, 'sendMessage', (p) => p.chat_id === chatId)).toBeUndefined();
    });

    it('кривляется, когда mirrorEnabled', async () => {
      const chatId = -1007000000010;
      await seedActiveChat(chatId);
      await configure({ mirrorEnabled: true });
      deepseek.completeText.mockResolvedValue('крокозябра');
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId: 7010, text: 'приветствую' }));

      await waitFor(() =>
        expect(
          findCall(h.calls, 'sendMessage', (p) => p.chat_id === chatId && String(p.text).includes('крокозябра'))
        ).toBeDefined()
      );
    });

    it('не кривляется, когда mirrorEnabled выключен', async () => {
      const chatId = -1007000000011;
      await seedActiveChat(chatId);
      await configure({ mirrorEnabled: false });
      h.clearCalls();

      await h.sendUpdate(groupMessageUpdate({ chatId, userId: 7011, text: 'приветствую' }));
      await settle();

      expect(deepseek.completeText).not.toHaveBeenCalled();
    });
  });

  describe('разбор дефекта в личке владельца', () => {
    it('находит ответ бота, пишет дефект и отвечает диагностикой', async () => {
      const chatId = -1007000000012;
      await seedActiveChat(chatId);
      await h.dataSource.getRepository(TrollMessageEntity).save({
        chatId,
        userId: 8001,
        userName: 'Вася',
        role: 'assistant',
        content: 'ты чё такой умный',
        messageId: 51,
        replyToMessageId: null,
      });
      deepseek.completeJson.mockResolvedValue({
        severity: 'high',
        summary: 'грубовато',
        problems: ['переход на личности'],
        fixSuggestions: ['быть мягче'],
      });
      h.clearCalls();

      await h.sendUpdate(privateMessageUpdate({ userId: OWNER_ID, text: 'ты чё такой умный', messageId: 60 }));

      await waitFor(() =>
        expect(
          findCall(
            h.calls,
            'sendMessage',
            (p) => p.chat_id === OWNER_ID && String(p.text).includes('Дефект #')
          )
        ).toBeDefined()
      );

      const defects = await h.dataSource.getRepository(TrollDefectEntity).find();
      expect(defects).toHaveLength(1);
      expect(defects[0].severity).toBe('high');
      expect(defects[0].sourceChatId).toBe(String(chatId));
      expect(defects[0].diagnosis).toContain('грубовато');
    });
  });
});
