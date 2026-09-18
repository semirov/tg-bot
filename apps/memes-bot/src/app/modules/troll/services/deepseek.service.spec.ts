import { Logger } from '@nestjs/common';

const mockPost = jest.fn();

jest.mock('axios', () => {
  const isAxiosError = (error: unknown): boolean =>
    Boolean(error && (error as { isAxiosError?: boolean }).isAxiosError === true);
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => ({ post: mockPost })),
      isAxiosError,
    },
    isAxiosError,
  };
});

import axios from 'axios';
import { DeepSeekService } from './deepseek.service';
import {
  TROLL_HARD_MAX_TOKENS,
  TROLL_LLM_MAX_RETRIES,
  TROLL_LLM_TIMEOUT_MS,
  TROLL_MAX_CONCURRENT_REQUESTS,
} from '../constants/troll-limits';

interface ConfigOverrides {
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  deepseekModel?: string;
  deepseekReasoningEffort?: string;
  deepseekPriceCacheHit?: number;
  deepseekPriceCacheMiss?: number;
  deepseekPriceOutput?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): any {
  return {
    deepseekApiKey: 'test-key',
    deepseekBaseUrl: 'https://api.deepseek.test',
    deepseekModel: 'deepseek-flash',
    deepseekReasoningEffort: 'none',
    deepseekPriceCacheHit: undefined,
    deepseekPriceCacheMiss: undefined,
    deepseekPriceOutput: undefined,
    ...overrides,
  };
}

function makeSettings(dailyRequestLimit = 2000): any {
  return { current: { dailyRequestLimit } };
}

function makeService(config: any = makeConfig(), settings: any = makeSettings()): DeepSeekService {
  return new DeepSeekService(config, settings);
}

function axiosError(overrides: Record<string, unknown> = {}): any {
  return { isAxiosError: true, message: 'Request failed', ...overrides };
}

function reply(content: string | undefined, usage?: unknown): any {
  return { data: { choices: [{ message: { content } }], usage } };
}

const USER = [{ role: 'user' as const, content: 'привет' }];

describe('DeepSeekService', () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPost.mockReset();
    // Ретрай ждёт 1.5с — в тестах «паузу» делаем мгновенной.
    setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      }) as any);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('конструктор и режим выключенного бота', () => {
    it('без ключа логирует ошибку и не отправляет запросы', async () => {
      const service = makeService(makeConfig({ deepseekApiKey: '' }));

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('DEEPSEEK_API_KEY не задан')
      );
      expect(await service.complete(USER)).toBe('');
      expect(mockPost).not.toHaveBeenCalled();
      expect(service.usage.requests).toBe(0);
    });
  });

  describe('complete', () => {
    it('отправляет корректный payload и возвращает обрезанный ответ', async () => {
      mockPost.mockResolvedValue(
        reply('  привет  ', { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 })
      );
      const service = makeService();

      const result = await service.complete(USER, {
        temperature: 0.5,
        maxTokens: 100,
        json: true,
        label: 'диалог',
        model: 'deepseek-v4-pro',
      });

      expect(result).toBe('привет');
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/chat/completions', {
        model: 'deepseek-v4-pro',
        messages: USER,
        temperature: 0.5,
        max_tokens: 100,
        reasoning_effort: 'none',
        response_format: { type: 'json_object' },
      });
    });

    it('подставляет рабочую модель и опускает необязательные поля', async () => {
      mockPost.mockResolvedValue(reply('ok'));
      const service = makeService(makeConfig({ deepseekReasoningEffort: '' }));

      await service.complete(USER, { json: false });

      expect(mockPost).toHaveBeenCalledWith('/chat/completions', {
        model: 'deepseek-flash',
        messages: USER,
        temperature: 0.9,
        max_tokens: 400,
      });
    });

    it('обрезает max_tokens жёстким потолком и снизу единицей', async () => {
      mockPost.mockResolvedValue(reply('ok'));
      const service = makeService();

      await service.complete(USER, { maxTokens: 5000 });
      expect(mockPost.mock.calls[0][1].max_tokens).toBe(TROLL_HARD_MAX_TOKENS);

      mockPost.mockClear();
      await service.complete(USER, { maxTokens: 0 });
      expect(mockPost.mock.calls[0][1].max_tokens).toBe(1);

      mockPost.mockClear();
      await service.complete(USER, { maxTokens: 10.9 });
      expect(mockPost.mock.calls[0][1].max_tokens).toBe(10);
    });

    it('возвращает пустую строку, если модель не дала контент', async () => {
      mockPost.mockResolvedValue({ data: {} });
      const service = makeService();

      expect(await service.complete(USER)).toBe('');
    });

    it('не падает, если у ответа нет поля data', async () => {
      mockPost.mockResolvedValue({});
      const service = makeService();

      expect(await service.complete(USER)).toBe('');
    });

    it('при нулевом лимите пишет в лог бесконечность', async () => {
      mockPost.mockResolvedValue(reply('ok'));
      const service = makeService(makeConfig(), makeSettings(0));

      await service.complete(USER);

      expect(Logger.prototype.log).toHaveBeenCalledWith(expect.stringContaining('/∞ запросов'));
    });

    it('подставляет дефолтные аргументы внутренних методов', async () => {
      mockPost.mockResolvedValue(reply('ok'));
      const service = makeService();

      expect(await (service as any).requestWithRetry(USER, 0.9, 100, false)).toBe('ok');
      (service as any).logPrompt(USER);

      expect(Logger.prototype.debug).toHaveBeenCalledWith(expect.stringContaining('LLM-данные'));
    });

    it('не отправляет запрос при исчерпанном суточном лимите', async () => {
      mockPost.mockResolvedValue(reply('ok'));
      const service = makeService(makeConfig(), makeSettings(1));

      expect(await service.complete(USER)).toBe('ok');
      expect(await service.complete(USER)).toBe('');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('логирует лимит не чаще раза в минуту', async () => {
      const service = makeService(makeConfig(), makeSettings(5));
      (service as any).dailyRequests = 5;

      expect(await service.complete(USER)).toBe('');
      expect(await service.complete(USER)).toBe('');

      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    });

    it('не превышает лимит одновременных запросов', async () => {
      const resolvers: ((value: unknown) => void)[] = [];
      mockPost.mockImplementation(
        () => new Promise((resolve) => resolvers.push(resolve as (value: unknown) => void))
      );
      const service = makeService();

      const inFlight = Array.from({ length: TROLL_MAX_CONCURRENT_REQUESTS }, () =>
        service.complete(USER)
      );
      const denied = await service.complete(USER);

      expect(denied).toBe('');
      resolvers.forEach((resolve) => resolve({ data: { choices: [{ message: { content: 'ok' } }] } }));
      expect(await Promise.all(inFlight)).toEqual(Array(TROLL_MAX_CONCURRENT_REQUESTS).fill('ok'));
    });

    it('повторяет запрос при 5xx и возвращает ответ со второй попытки', async () => {
      mockPost
        .mockRejectedValueOnce(axiosError({ response: { status: 503 } }))
        .mockResolvedValueOnce(reply('после повтора'));
      const service = makeService();

      expect(await service.complete(USER)).toBe('после повтора');
      expect(mockPost).toHaveBeenCalledTimes(TROLL_LLM_MAX_RETRIES + 1);
    });

    it('сдаётся после всех повторов', async () => {
      mockPost.mockRejectedValue(axiosError({ response: { status: 500 } }));
      const service = makeService();

      expect(await service.completeText('sys', 'user')).toBeNull();
      expect(mockPost).toHaveBeenCalledTimes(TROLL_LLM_MAX_RETRIES + 1);
    });

    it('не повторяет запрос при 4xx', async () => {
      mockPost.mockRejectedValue(axiosError({ response: { status: 400 } }));
      const service = makeService();

      expect(await service.completeText('sys', 'user')).toBeNull();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('не повторяет не-axios ошибку', async () => {
      mockPost.mockRejectedValue(new Error('boom'));
      const service = makeService();

      expect(await service.completeText('sys', 'user')).toBeNull();
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).toHaveBeenCalledWith('DeepSeek request failed: boom');
    });

    it('освобождает слот после ошибки', async () => {
      mockPost
        .mockRejectedValueOnce(axiosError({ response: { status: 400 } }))
        .mockResolvedValueOnce(reply('снова жив'));
      const service = makeService();

      await service.completeText('sys', 'user');
      expect(await service.complete(USER)).toBe('снова жив');
    });

    it('снимает unref у таймера паузы, если он есть', async () => {
      const unref = jest.fn();
      setTimeoutSpy.mockImplementation(((callback: () => void) => {
        callback();
        return { unref };
      }) as any);
      mockPost
        .mockRejectedValueOnce(axiosError({ response: { status: 500 } }))
        .mockResolvedValueOnce(reply('после повтора'));
      const service = makeService();

      expect(await service.complete(USER)).toBe('после повтора');
      expect(unref).toHaveBeenCalled();
    });
  });

  describe('лог промпта и данных', () => {
    it('системный промпт пишет в лог один раз, данные — каждый раз', async () => {
      mockPost.mockResolvedValue(reply('ok'));
      const service = makeService();
      const messages = [
        { role: 'system' as const, content: 'система\n\nс переносом' },
        { role: 'user' as const, content: 'пользователь' },
      ];

      await service.complete(messages);
      await service.complete(messages);

      const promptLogs = (Logger.prototype.debug as jest.Mock).mock.calls.filter((call) =>
        String(call[0]).includes('LLM-промпт')
      );
      expect(promptLogs).toHaveLength(1);
      expect(String(promptLogs[0][0])).toContain('система');
      const dataLogs = (Logger.prototype.debug as jest.Mock).mock.calls.filter((call) =>
        String(call[0]).includes('LLM-данные')
      );
      expect(dataLogs).toHaveLength(2);
    });

    it('пишет полученный ответ в лог, схлопывая переносы', async () => {
      mockPost.mockResolvedValue(reply('первая\nвторая'));
      const service = makeService();

      await service.complete(USER);

      const responseLog = (Logger.prototype.debug as jest.Mock).mock.calls.find((call) =>
        String(call[0]).includes('LLM-ответ')
      );
      expect(String(responseLog?.[0])).toContain('первая ⏎ вторая');
    });
  });

  describe('completeJson', () => {
    it('разбирает JSON-ответ модели', async () => {
      mockPost.mockResolvedValue(reply('{"years": 3, "articles": []}'));
      const service = makeService();

      expect(await service.completeJson<{ years: number }>('sys', 'user')).toEqual({
        years: 3,
        articles: [],
      });
      expect(mockPost.mock.calls[0][1].response_format).toEqual({ type: 'json_object' });
    });

    it('возвращает null и предупреждает, если JSON не разобрался', async () => {
      mockPost.mockResolvedValue(reply('чёт я подвис'));
      const service = makeService();

      expect(await service.completeJson('sys', 'user')).toBeNull();
      expect(Logger.prototype.warn).toHaveBeenCalledWith('Failed to parse DeepSeek JSON');
    });

    it('возвращает null на пустом ответе', async () => {
      mockPost.mockResolvedValue(reply('   '));
      const service = makeService();

      expect(await service.completeJson('sys', 'user')).toBeNull();
    });

    it('возвращает null при ошибке запроса', async () => {
      mockPost.mockRejectedValue(axiosError({ response: { status: 401 } }));
      const service = makeService();

      expect(await service.completeJson('sys', 'user')).toBeNull();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('DeepSeek request failed')
      );
    });
  });

  describe('completeText', () => {
    it('возвращает текст ответа', async () => {
      mockPost.mockResolvedValue(reply('ответ'));
      const service = makeService();

      expect(await service.completeText('sys', 'user', { label: 'метка' })).toBe('ответ');
    });

    it('превращает пустой ответ модели в null', async () => {
      mockPost.mockResolvedValue(reply(''));
      const service = makeService();

      expect(await service.completeText('sys', 'user')).toBeNull();
    });
  });

  describe('учёт расхода', () => {
    it('считает токены и стоимость по своему тарифу', async () => {
      mockPost.mockResolvedValue(
        reply('ok', {
          total_tokens: 1500,
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1000,
        })
      );
      const service = makeService(
        makeConfig({ deepseekPriceCacheHit: 0, deepseekPriceCacheMiss: 2, deepseekPriceOutput: 3 })
      );

      await service.complete(USER);

      expect(service.usage.tokens).toBe(1500);
      expect(service.usage.requests).toBe(1);
      expect(service.usage.costUsd).toBeCloseTo((1000 * 2 + 500 * 3) / 1_000_000, 12);
      expect(typeof service.usage.peak).toBe('boolean');
    });

    it('без полного override берёт табличный тариф', async () => {
      mockPost.mockResolvedValue(reply('ok', { total_tokens: 1000, prompt_tokens: 1000 }));
      const overrideService = makeService(
        makeConfig({ deepseekPriceCacheHit: 9, deepseekPriceCacheMiss: undefined, deepseekPriceOutput: 9 })
      );
      const plainService = makeService();

      await overrideService.complete(USER);
      await plainService.complete(USER);

      expect(overrideService.usage.costUsd).toBeCloseTo(plainService.usage.costUsd, 12);
      expect(overrideService.usage.costUsd).toBeGreaterThan(0);
    });

    it('не учитывает мусорные и нулевые токены', async () => {
      const service = makeService();

      (service as any).recordUsage({ total_tokens: -5, prompt_tokens: 'нет', completion_tokens: 'нет' });
      expect(service.usage.tokens).toBe(0);
      expect(service.usage.costUsd).toBe(0);

      (service as any).recordUsage(undefined);
      expect(service.usage.costUsd).toBe(0);

      (service as any).recordUsage({
        total_tokens: 10,
        prompt_tokens: -1,
        completion_tokens: 10,
        prompt_cache_hit_tokens: -3,
      });
      expect(service.usage.tokens).toBe(10);
      expect(service.usage.costUsd).toBeGreaterThan(0);
    });

    it('сбрасывает счётчики при смене суток', async () => {
      mockPost.mockResolvedValue(reply('ok', { total_tokens: 100, prompt_tokens: 100 }));
      const service = makeService();

      await service.complete(USER);
      expect(service.usage.requests).toBe(1);

      (service as any).dailyKey = '2000-01-01';
      expect(service.usage.requests).toBe(0);
      expect(service.usage.tokens).toBe(0);
      expect(service.usage.costUsd).toBe(0);
    });
  });

  describe('описание ошибок в логах', () => {
    async function errorText(error: unknown): Promise<string> {
      mockPost.mockRejectedValue(error);
      const service = makeService();
      await service.completeText('sys', 'user');
      const calls = (Logger.prototype.error as jest.Mock).mock.calls;
      return String(calls[calls.length - 1][0]);
    }

    it('опознаёт таймаут по коду и по тексту', async () => {
      expect(await errorText(axiosError({ code: 'ECONNABORTED' }))).toContain('таймаут 45с');
      expect(await errorText(axiosError({ message: 'Request aborted by client' }))).toContain(
        'таймаут 45с'
      );
    });

    it('опознаёт ошибку на стороне DeepSeek', async () => {
      expect(await errorText(axiosError({ response: { status: 502 } }))).toContain(
        'ошибка на стороне DeepSeek (status 502)'
      );
    });

    it('показывает статус и код прочих axios-ошибок', async () => {
      const text = await errorText(
        axiosError({ message: 'Request failed', code: 'ERR_BAD_REQUEST', response: { status: 429 } })
      );
      expect(text).toContain('Request failed (status 429), код ERR_BAD_REQUEST');
    });

    it('показывает только код, если статуса нет', async () => {
      expect(await errorText(axiosError({ message: 'socket hang up', code: 'ECONNRESET' }))).toContain(
        'socket hang up, код ECONNRESET'
      );
    });

    it('разворачивает обычную ошибку и строку', async () => {
      expect(await errorText(new Error('плохо'))).toContain('плохо');
      expect(await errorText('просто строка')).toContain('просто строка');
    });

    it('ожидает таймаут стандартной длительности', () => {
      expect(TROLL_LLM_TIMEOUT_MS).toBeGreaterThan(0);
      expect(typeof axios.isAxiosError).toBe('function');
    });
  });
});
