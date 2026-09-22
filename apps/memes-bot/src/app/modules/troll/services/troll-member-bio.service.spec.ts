jest.mock('./deepseek.service', () => ({ DeepSeekService: class DeepSeekService {} }));

import { TrollMemberBioService } from './troll-member-bio.service';
import { TROLL_MEMBER_BIO_CANARY, TROLL_MEMBER_BIO_UPDATE_EVERY } from '../constants/troll-limits';

const CHAT = -100500;
const USER = 42;

function historyRow(id: number, content: string): any {
  return {
    id,
    chatId: CHAT,
    userId: USER,
    userName: 'Вася',
    role: 'user',
    content,
    messageId: 1000 + id,
    replyToMessageId: null,
    createdAt: new Date(),
  };
}

function bioRow(over: any = {}): any {
  return {
    id: 7,
    chatId: CHAT,
    userId: USER,
    userName: 'Вася',
    lastMessageId: 0,
    facts: null,
    lastEvaluatedAt: null,
    updatedAt: new Date(),
    ...over,
  };
}

function setup(options: {
  rows?: any[];
  stored?: any;
  all?: any[];
  extracted?: unknown;
  count?: number;
  enabled?: boolean;
  bioEnabled?: boolean;
} = {}) {
  const deepSeek = {
    completeJson: jest.fn().mockResolvedValue(
      options.extracted === undefined
        ? { facts: [{ text: 'Живёт в Санкт-Петербурге', importance: 4, self: true, evidence: 'живу в спб' }] }
        : options.extracted
    ),
  };
  const settings = {
    current: { enabled: options.enabled ?? true, memberBioEnabled: options.bioEnabled ?? true },
  };
  const history = {
    count: jest.fn().mockResolvedValue(options.count ?? 0),
    find: jest.fn().mockResolvedValue(options.rows ?? [historyRow(10, 'живу в спб'), historyRow(11, 'люблю питер')]),
  };
  const bios = {
    findOne: jest.fn().mockResolvedValue(options.stored ?? null),
    find: jest.fn().mockResolvedValue(options.all ?? []),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const service = new TrollMemberBioService(
    deepSeek as never,
    settings as never,
    bios as never,
    history as never
  );
  return { service, deepSeek, settings, history, bios };
}

describe('TrollMemberBioService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('noteUserMessage', () => {
    it('выключенный тролль или био — ничего не делает', async () => {
      const off = setup({ enabled: false });
      await off.service.noteUserMessage(CHAT, USER);
      expect(off.bios.findOne).not.toHaveBeenCalled();

      const noBio = setup({ bioEnabled: false });
      await noBio.service.noteUserMessage(CHAT, USER);
      expect(noBio.bios.findOne).not.toHaveBeenCalled();
    });

    it('запускает обновление на каждую N-ю реплику', async () => {
      const { service, bios } = setup();
      const refresh = jest.spyOn(service, 'refreshBio').mockResolvedValue(undefined);
      for (let index = 0; index < TROLL_MEMBER_BIO_UPDATE_EVERY - 1; index += 1) {
        await service.noteUserMessage(CHAT, USER, 'Вася');
      }
      expect(refresh).not.toHaveBeenCalled();
      await service.noteUserMessage(CHAT, USER, 'Вася');
      expect(refresh).toHaveBeenCalledWith(CHAT, USER, 'Вася');
      expect(bios.findOne).toHaveBeenCalled();
    });
  });

  describe('refreshBio', () => {
    it('не двигает курсор, если модель не ответила', async () => {
      const { service, bios } = setup({ extracted: null });
      await service.refreshBio(CHAT, USER, 'Вася');
      expect(bios.save).not.toHaveBeenCalled();
    });

    it('сохраняет извлечённые факты и двигает курсор', async () => {
      const { service, bios } = setup();
      await service.refreshBio(CHAT, USER, 'Вася');
      expect(bios.save).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: CHAT, userId: USER, userName: 'Вася', lastMessageId: 11 })
      );
      const saved = bios.save.mock.calls[0][0];
      expect(saved.facts).toHaveLength(1);
      expect(saved.facts[0].text).toBe('Живёт в Санкт-Петербурге');
    });

    it('сливает с существующим досье и считает ядро', async () => {
      const stored = bioRow({
        lastMessageId: 5,
        facts: [
          {
            text: 'Живёт в Санкт-Петербурге',
            importance: 3,
            count: 1,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            baseWeight: 1,
            weight: 1,
          },
        ],
      });
      const { service, bios } = setup({ stored });
      await service.refreshBio(CHAT, USER, 'Вася');
      const saved = bios.save.mock.calls[0][0];
      expect(saved.facts).toHaveLength(1);
      expect(saved.facts[0].count).toBe(2);
    });

    it('без новых реплик ничего не делает', async () => {
      const { service, bios } = setup({ rows: [] });
      await service.refreshBio(CHAT, USER);
      expect(bios.save).not.toHaveBeenCalled();
    });

    it('повторный вызов при активном обновлении пропускается', async () => {
      const { service, history } = setup();
      (service as never as { inFlight: Set<string> }).inFlight.add(`${CHAT}:${USER}`);
      await service.refreshBio(CHAT, USER);
      expect(history.find).not.toHaveBeenCalled();
    });

    it('сбой истории не роняет сервис', async () => {
      const { service, history, bios } = setup();
      history.find.mockRejectedValue(new Error('db down'));
      await service.refreshBio(CHAT, USER);
      expect(bios.save).not.toHaveBeenCalled();
    });

    it('ошибка подсчёта ожидающих реплик — ноль', async () => {
      const { service, bios } = setup();
      bios.findOne.mockRejectedValue(new Error('db'));
      await expect((service as never as { countPending: (c: number, u: number) => Promise<number> }).countPending(CHAT, USER)).resolves.toBe(0);
    });
  });

  describe('buildInjection', () => {
    it('выключено или пусто — null', async () => {
      const off = setup({ bioEnabled: false });
      await expect(off.service.buildInjection(CHAT, [USER])).resolves.toBeNull();
      const empty = setup({ all: [] });
      await expect(empty.service.buildInjection(CHAT, [USER])).resolves.toBeNull();
      const noUsers = setup();
      await expect(noUsers.service.buildInjection(CHAT, [])).resolves.toBeNull();
    });

    it('собирает блок с canary и фактами', async () => {
      const fact = (text: string) => ({
        text,
        importance: 3,
        count: 2,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        baseWeight: 2,
        weight: 2,
      });
      const all = [
        bioRow({ userId: USER, userName: 'Вася', facts: [fact('Живёт в СПб')] }),
        bioRow({ userId: 99, userName: 'Пусто', facts: [] }),
      ];
      const { service } = setup({ all });
      const result = await service.buildInjection(CHAT, [USER, 99]);
      expect(result).not.toBeNull();
      expect(result!.canary).toBe(TROLL_MEMBER_BIO_CANARY);
      expect(result!.body).toContain('Вася');
      expect(result!.body).toContain('Живёт в СПб');
      expect(result!.facts).toEqual(['Живёт в СПб']);
    });

    it('сбой репозитория — null', async () => {
      const { service, bios } = setup();
      bios.find.mockRejectedValue(new Error('db'));
      await expect(service.buildInjection(CHAT, [USER])).resolves.toBeNull();
    });
  });

  it('getChatBios делегирует в репозиторий', async () => {
    const { service, bios } = setup({ all: [bioRow()] });
    const rows = await service.getChatBios(CHAT);
    expect(rows).toHaveLength(1);
    expect(bios.find).toHaveBeenCalledWith({ where: { chatId: CHAT }, order: { updatedAt: 'DESC' } });
  });

  describe('decayBiosJob', () => {
    it('выключено — ничего не делает', async () => {
      const { service, bios } = setup({ bioEnabled: false });
      await service.decayBiosJob();
      expect(bios.find).not.toHaveBeenCalled();
    });

    it('вымывает ослабшие факты и сохраняет', async () => {
      const stale = {
        text: 'старое',
        importance: 1,
        count: 1,
        firstSeenAt: Date.now() - 10_000 * 3600 * 1000,
        lastSeenAt: Date.now() - 10_000 * 3600 * 1000,
        baseWeight: 1,
        weight: 1,
      };
      const { service, bios } = setup({ all: [bioRow({ facts: [stale] })] });
      await service.decayBiosJob();
      expect(bios.update).toHaveBeenCalledWith({ id: 7 }, { facts: [] });
    });

    it('сбой репозитория не роняет сервис', async () => {
      const { service, bios } = setup();
      bios.find.mockRejectedValue(new Error('db'));
      await expect(service.decayBiosJob()).resolves.toBeUndefined();
    });
  });

  describe('дополнительные ветки', () => {
    it('не обновляет чаще минимального интервала', async () => {
      const { service } = setup();
      const refresh = jest.spyOn(service, 'refreshBio').mockResolvedValue(undefined);
      for (let index = 0; index < TROLL_MEMBER_BIO_UPDATE_EVERY * 2; index += 1) {
        await service.noteUserMessage(CHAT, USER, 'Вася');
      }
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('refreshBio при выключенном био выходит без запросов', async () => {
      const { service, history } = setup({ bioEnabled: false });
      await service.refreshBio(CHAT, USER);
      expect(history.find).not.toHaveBeenCalled();
    });

    it('принимает строковые факты и отсеивает мусор', async () => {
      const { service, bios } = setup({
        extracted: { facts: [null, 42, { text: '', importance: 3, self: true, evidence: 'x' }, { text: 'строковый факт про спб', importance: 3, self: true, evidence: 'я в спб' }] },
      });
      await service.refreshBio(CHAT, USER, 'Вася');
      const saved = bios.save.mock.calls[0][0];
      expect(saved.facts.map((item: any) => item.text)).toEqual(['строковый факт про спб']);
    });

    it('обрезает факты по потолку символов', async () => {
      const facts = Array.from({ length: 12 }, (_, index) => ({
        text: `факт${index} ${'слово'.repeat(24)}`,
        importance: 5,
        self: true,
        evidence: 'да',
      }));
      const { service, bios } = setup({ extracted: { facts } });
      await service.refreshBio(CHAT, USER, 'Вася');
      const saved = bios.save.mock.calls[0][0];
      expect(saved.facts.length).toBeGreaterThan(0);
      expect(saved.facts.length).toBeLessThan(12);
    });

    it('пропускает отсутствующих участников и пустые досье', async () => {
      const fact = (text: string) => ({
        text,
        importance: 3,
        count: 2,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        baseWeight: 2,
        weight: 2,
      });
      const all = [
        bioRow({ userId: USER, userName: 'Вася', facts: [fact('Живёт в СПб')] }),
        bioRow({ userId: 5, userName: 'Пусто', facts: [] }),
      ];
      const { service } = setup({ all });
      const result = await service.buildInjection(CHAT, [USER, 12345, 5]);
      expect(result!.body).toContain('Вася');
      const onlyEmpty = setup({ all: [bioRow({ facts: [] })] });
      await expect(onlyEmpty.service.buildInjection(CHAT, [USER])).resolves.toBeNull();
    });

    it('останавливается на потолке числа досье', async () => {
      const bigFact = (name: string) => ({
        text: name + ' ' + 'ф'.repeat(120),
        importance: 5,
        count: 2,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        baseWeight: 2,
        weight: 2,
      });
      const all = Array.from({ length: 7 }, (_, index) =>
        bioRow({ userId: index + 1, userName: `У${index + 1}`, facts: [bigFact(`факт${index + 1}`)] })
      );
      const { service } = setup({ all });
      const result = await service.buildInjection(CHAT, [1, 2, 3, 4, 5, 6, 7]);
      expect(result).not.toBeNull();
      expect(result!.body).toContain('У1');
      expect(result!.body).not.toContain('У7');
    });
  });

  describe('null-ветки', () => {
    it('countPending: курсор задан и не задан', async () => {
      const withCursor = setup({ stored: bioRow({ lastMessageId: 5 }) });
      await (withCursor.service as any).countPending(CHAT, USER);
      const where = withCursor.history.count.mock.calls[0][0].where;
      expect(where.id).toBeDefined();

      const noCursor = setup({ stored: bioRow({ lastMessageId: null }) });
      await (noCursor.service as any).countPending(CHAT, USER);
      const where2 = noCursor.history.count.mock.calls[0][0].where;
      expect(where2.id).toBeUndefined();
    });

    it('refreshBio с пустыми userName/facts', async () => {
      const stored = bioRow({ facts: null, userName: null, lastMessageId: 3 });
      const { service, bios } = setup({ stored });
      await service.refreshBio(CHAT, USER);
      const saved = bios.save.mock.calls[0][0];
      expect(saved.userName).toBeNull();
      expect(saved.facts.length).toBeGreaterThan(0);
    });

    it('buildInjection c null userName и null facts', async () => {
      const fact = {
        text: 'Есть факт',
        importance: 3,
        count: 2,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        baseWeight: 2,
        weight: 2,
      };
      const all = [
        bioRow({ userId: 1, userName: null, facts: [fact] }),
        bioRow({ userId: 2, userName: 'Ноль', facts: null }),
      ];
      const { service } = setup({ all });
      const result = await service.buildInjection(CHAT, [1, 2]);
      expect(result).not.toBeNull();
      expect(result!.body).toContain('участник');
    });

    it('decayBiosJob пропускает досье без фактов', async () => {
      const { service, bios } = setup({ all: [bioRow({ facts: null })] });
      await service.decayBiosJob();
      expect(bios.update).not.toHaveBeenCalled();
    });

    it('noteUserMessage переживает сбой подсчёта', async () => {
      const { service, bios } = setup();
      bios.findOne.mockRejectedValue(new Error('db'));
      await expect(service.noteUserMessage(CHAT, USER, 'Вася')).resolves.toBeUndefined();
    });
  });

  describe('защитные ветки', () => {
    function anyRow(over: any = {}): any {
      return {
        id: 20,
        chatId: CHAT,
        userId: USER,
        userName: 'Вася',
        role: 'user',
        content: 'текст',
        messageId: 1,
        replyToMessageId: null,
        createdAt: new Date(),
        ...over,
      };
    }

    it('переживает строку вместо ошибки', async () => {
      const { service, history } = setup();
      history.find.mockRejectedValue('oops');
      await expect(service.refreshBio(CHAT, USER)).resolves.toBeUndefined();
      const pending = setup();
      pending.bios.findOne.mockRejectedValue('oops');
      await expect((pending.service as any).countPending(CHAT, USER)).resolves.toBe(0);
    });

    it('реплика без текста не роняет извлечение', async () => {
      const { service, bios } = setup({ rows: [anyRow({ content: null })] });
      await service.refreshBio(CHAT, USER, 'Вася');
      expect(bios.save).toHaveBeenCalled();
    });

    it('пустой, но валидный список фактов сохраняется', async () => {
      const { service, bios } = setup({ extracted: { facts: [] } });
      await service.refreshBio(CHAT, USER, 'Вася');
      const saved = bios.save.mock.calls[0][0];
      expect(saved.facts).toEqual([]);
    });

    it('битый JSON без массива фактов не двигает курсор', async () => {
      const { service, bios } = setup({ extracted: { facts: 'нет' } });
      await service.refreshBio(CHAT, USER, 'Вася');
      expect(bios.save).not.toHaveBeenCalled();
    });

    it('нестроковые text и importance фактов', async () => {
      const { service, bios } = setup({
        extracted: { facts: [{ text: 123, importance: 3 }, { text: 'нормальный факт', importance: 'abc', self: true, evidence: 'да' }] },
      });
      await service.refreshBio(CHAT, USER, 'Вася');
      const saved = bios.save.mock.calls[0][0];
      expect(saved.facts.map((item: any) => item.text)).toEqual(['нормальный факт']);
      expect(saved.facts[0].importance).toBe(3);
    });

    it('создание досье без имени', async () => {
      const { service, bios } = setup({ stored: null });
      await service.refreshBio(CHAT, USER);
      expect(bios.save.mock.calls[0][0].userName).toBeNull();
    });

    it('имя берётся из аргумента, строки или null', async () => {
      const fromArg = setup({ stored: bioRow({ userName: null }) });
      await fromArg.service.refreshBio(CHAT, USER, 'Новое');
      expect(fromArg.bios.save.mock.calls[0][0].userName).toBe('Новое');

      const fromRow = setup({ stored: bioRow({ userName: 'Старое' }) });
      await fromRow.service.refreshBio(CHAT, USER);
      expect(fromRow.bios.save.mock.calls[0][0].userName).toBe('Старое');
    });
  });

  describe('прунинг и граничные ветки', () => {
    it('capFacts обрезает по потолку символов', () => {
      const { service } = setup();
      const facts = Array.from({ length: 12 }, (_, index) => ({
        text: 'ф'.repeat(120) + index,
        importance: 3,
        count: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        baseWeight: 1,
        weight: 1,
      }));
      const kept = (service as any).capFacts(facts, 1000);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(12);
    });

    it('noteUserMessage игнорирует нечисловые id', async () => {
      const { service, bios } = setup();
      await expect(service.noteUserMessage(CHAT, Number.NaN, 'Вася')).resolves.toBeUndefined();
      expect(bios.findOne).not.toHaveBeenCalled();
    });

    it('распад пропускает досье в работе', async () => {
      const { service, bios } = setup({ all: [bioRow({ facts: null })] });
      (service as any).inFlight.add(`${CHAT}:${USER}`);
      await service.decayBiosJob();
      expect(bios.update).not.toHaveBeenCalled();
    });

    it('чистит старые записи триггера', async () => {
      const { service } = setup({ all: [] });
      (service as any).lastRunAt.set(`${CHAT}:${USER}`, Date.now() - 10 * 24 * 3600 * 1000);
      (service as any).counters.set(`${CHAT}:${USER}`, 5);
      await service.decayBiosJob();
      expect((service as any).lastRunAt.has(`${CHAT}:${USER}`)).toBe(false);
      expect((service as any).counters.has(`${CHAT}:${USER}`)).toBe(false);
    });
  });
});
