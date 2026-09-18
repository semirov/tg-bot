import {
  E2EHarness,
  createE2EHarness,
  findCall,
  groupMessageUpdate,
  privateMessageUpdate,
} from './harness';

const OWNER_ID = Number(process.env.BOT_OWNER_ID);

describe('E2E: старт приложения и онбординг', () => {
  let h: E2EHarness;

  // Харнес на каждый тест: изолируем сессию и активные конверсации.
  beforeEach(async () => {
    h = await createE2EHarness();
    await h.resetDb();
  });

  afterEach(async () => {
    await h.close();
  });

  it('на старте отправляет владельцу уведомление с версией', () => {
    const notification = findCall(h.startupCalls, 'sendMessage', (p) => p.chat_id === OWNER_ID);

    expect(notification).toBeDefined();
    expect(String(notification!.payload.text)).toContain('Бот запущен');
    expect(String(notification!.payload.text)).toContain('Версия:');
  });

  it('/start в личке отвечает приветствием', async () => {
    await h.sendUpdate(privateMessageUpdate({ text: '/start' }));

    const reply = findCall(h.calls, 'sendMessage', (p) => p.chat_id === OWNER_ID);
    expect(reply).toBeDefined();
    expect(String(reply!.payload.text)).toContain('Привет');
  });

  it('/menu в личке показывает меню с клавиатурой', async () => {
    await h.sendUpdate(privateMessageUpdate({ text: '/menu', messageId: 11 }));

    const reply = findCall(h.calls, 'sendMessage', (p) => p.chat_id === OWNER_ID && !!p.reply_markup);
    expect(reply).toBeDefined();
    expect(reply!.payload.text).toContain('Выбери то, что хочешь сделать');
  });

  it('/menu в группе игнорируется', async () => {
    await h.sendUpdate(groupMessageUpdate({ text: '/menu', messageId: 21 }));

    expect(findCall(h.calls, 'sendMessage')).toBeUndefined();
  });
});
