import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { metrics } from '../../../shared/metrics';
import { BaseConfigService } from '../../config/base-config.service';
import {
  TROLL_HARD_MAX_TOKENS,
  TROLL_LLM_MAX_RETRIES,
  TROLL_LLM_RETRY_DELAY_MS,
  TROLL_LLM_TIMEOUT_MS,
  TROLL_MAX_CONCURRENT_REQUESTS,
} from '../constants/troll-limits';
import { DeepSeekMessage, DeepSeekOptions } from '../interfaces/troll.interface';
import { parseLlmJson } from '../utils/llm-json';
import {
  DeepSeekTariff,
  estimateCostUsd,
  formatUsd,
  isDeepSeekPeak,
} from '../constants/deepseek-pricing';
import { TrollSettingsService } from './troll-settings.service';

/**
 * Клиент для DeepSeek API (OpenAI-совместимый /chat/completions).
 *
 * Все вызовы проходят через защиту от перерасхода токенов:
 *  - жёсткий потолок max_tokens на запрос;
 *  - лимит одновременных запросов;
 *  - суточный лимит запросов (настраивается в админке);
 *  - таймаут на запрос и один повтор при сетевом сбое/таймауте.
 * Плюс ведётся учёт суточного расхода: запросы, токены и стоимость в долларах
 * по официальному тарифу DeepSeek (см. constants/deepseek-pricing.ts).
 * При исчерпании лимитов запрос не отправляется, возвращается пустой ответ.
 */
@Injectable()
export class DeepSeekService {
  private readonly logger = new Logger(DeepSeekService.name);
  private readonly client: AxiosInstance;

  /** Сколько запросов сейчас в полёте. */
  private activeRequests = 0;
  /** Системные промпты, уже выведенные в лог (чтобы не дублировать их каждый раз). */
  private readonly loggedPrompts = new Set<string>();
  /** Есть ли ключ DeepSeek: без него запросы отправлять бессмысленно. */
  private readonly enabled: boolean;
  /** Счётчики за текущие сутки. */
  private dailyKey = this.todayKey();
  private dailyRequests = 0;
  private dailyTokens = 0;
  private dailyCostUsd = 0;
  private lastBudgetWarnAt = 0;

  constructor(
    private readonly config: BaseConfigService,
    private readonly settings: TrollSettingsService
  ) {
    this.enabled = !!this.config.deepseekApiKey;
    if (!this.enabled) {
      this.logger.error(
        'DEEPSEEK_API_KEY не задан — тролль-бот не сможет обращаться к модели (LLM-ответы выключены)'
      );
    }

    this.client = axios.create({
      baseURL: this.config.deepseekBaseUrl,
      timeout: TROLL_LLM_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${this.config.deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Возвращает текстовый ответ модели. Пустая строка означает, что запрос
   * не был выполнен (лимит, перегрузка) или модель вернула пустой ответ.
   */
  public async complete(
    messages: DeepSeekMessage[],
    options: DeepSeekOptions = {}
  ): Promise<string> {
    const { temperature = 0.9, maxTokens = 400, json = false, label, model } = options;
    // Модель можно переопределить для отдельного вызова: диагностика дефекта
    // идёт на старшей модели, вся остальная работа — на рабочей.
    const useModel = model ?? this.config.deepseekModel;
    const llmLabel = label ?? 'default';
    if (!this.enabled) {
      metrics.llm.requests.inc({ model: useModel, label: llmLabel, result: 'disabled' });
      return '';
    }
    const tag = label ? `[${label}] ` : '';
    const cappedMaxTokens = Math.min(
      Math.max(1, Math.floor(maxTokens)),
      TROLL_HARD_MAX_TOKENS
    );

    if (!this.tryAcquire()) {
      this.logger.debug('DeepSeek: запрос не отправлен (лимит или перегрузка)');
      metrics.llm.requests.inc({ model: useModel, label: llmLabel, result: 'skipped' });
      return '';
    }

    this.logger.debug(
      `${tag}DeepSeek: запрос (model=${useModel}, max_tokens=${cappedMaxTokens}, сообщений=${messages.length}, json=${json}, reasoning_effort=${this.config.deepseekReasoningEffort || 'по умолчанию'})`
    );

    this.logPrompt(messages, tag);

    const startedAt = Date.now();
    try {
      const content = await this.requestWithRetry(messages, temperature, cappedMaxTokens, json, tag, useModel);
      this.observeLlmRequest(useModel, llmLabel, 'ok', startedAt);
      return content;
    } catch (error) {
      this.observeLlmRequest(useModel, llmLabel, this.llmErrorResult(error), startedAt);
      throw error;
    } finally {
      this.release();
    }
  }

  /** Пишет в реестр исход и длительность одного запроса к модели. */
  private observeLlmRequest(
    model: string,
    label: string,
    result: string,
    startedAt: number
  ): void {
    metrics.llm.requests.inc({ model, label, result });
    metrics.llm.duration.observe({ model, label }, (Date.now() - startedAt) / 1000);
  }

  /** Различает таймаут и прочие ошибки модели для метки результата. */
  private llmErrorResult(error: unknown): string {
    if (
      axios.isAxiosError(error) &&
      (error.code === 'ECONNABORTED' || /abort|timeout/i.test(error.message))
    ) {
      return 'timeout';
    }
    return 'error';
  }

  /**
   * Отправляет запрос, повторяя его при сетевом сбое или таймауте.
   * Если все попытки провалились — выбрасывает исключение, вызывающий код
   * трактует его как «модель не ответила».
   */
  private async requestWithRetry(
    messages: DeepSeekMessage[],
    temperature: number,
    maxTokens: number,
    json: boolean,
    tag = '',
    model = this.config.deepseekModel
  ): Promise<string> {
    let lastError: unknown;
    const reasoningEffort = this.config.deepseekReasoningEffort;

    for (let attempt = 0; attempt <= TROLL_LLM_MAX_RETRIES; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await this.client.post('/chat/completions', {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          // deepseek-flash — reasoning-модель: без явного отключения размышления
          // съедают весь max_tokens, и короткие ответы приходят пустыми.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        });

        this.recordUsage(response.data?.usage, model);

        const limit = this.settings.current.dailyRequestLimit;
        this.logger.log(
          `${tag}DeepSeek: ответ за ${Date.now() - startedAt}мс, tokens=${
            response.data?.usage?.total_tokens ?? '?'
          }, сегодня ${formatUsd(this.dailyCostUsd)}, ${this.dailyRequests}/${
            limit > 0 ? limit : '∞'
          } запросов`
        );

        const content: string = response.data?.choices?.[0]?.message?.content?.trim() ?? '';
        // Сырой ответ модели пишем целиком — без него не разобрать поведение промпта.
        this.logger.debug(`${tag}LLM-ответ: ${this.flatten(content) || '(пусто)'}`);

        return content;
      } catch (error) {
        lastError = error;
        const canRetry = attempt < TROLL_LLM_MAX_RETRIES && this.isRetriable(error);
        this.logger.warn(
          `${tag}DeepSeek: запрос не удался за ${Date.now() - startedAt}мс — ${this.describeError(
            error
          )}${canRetry ? `, повтор ${attempt + 1}/${TROLL_LLM_MAX_RETRIES}` : ''}`
        );
        if (!canRetry) {
          throw error;
        }
        await this.delay(TROLL_LLM_RETRY_DELAY_MS);
      }
    }

    throw lastError;
  }

  /**
   * Повторяем только «сетевые» сбои: таймаут, обрыв соединения, 429 и 5xx.
   * Ошибки вида 400/401 повторять бессмысленно.
   */
  private isRetriable(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    const status = error.response?.status;
    if (status === undefined) {
      return true;
    }
    return status === 429 || status >= 500;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    });
  }

  /**
   * Возвращает ответ модели, распарсенный как JSON.
   * При ошибке парсинга пытается вытащить JSON из текста.
   */
  public async completeJson<T>(
    system: string,
    user: string,
    options: DeepSeekOptions = {}
  ): Promise<T | null> {
    let raw: string;
    try {
      raw = await this.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { ...options, json: true }
      );
    } catch (error) {
      this.logger.error(`DeepSeek request failed: ${this.describeError(error)}`);
      return null;
    }

    if (!raw) {
      return null;
    }

    const parsed = parseLlmJson<T>(raw);
    if (parsed === null) {
      this.logger.warn('Failed to parse DeepSeek JSON');
      return null;
    }

    return parsed;
  }

  /**
   * Возвращает короткий текстовый ответ по системному промпту.
   */
  public async completeText(
    system: string,
    user: string,
    options: DeepSeekOptions = {}
  ): Promise<string | null> {
    try {
      const result = await this.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options
      );
      return result || null;
    } catch (error) {
      this.logger.error(`DeepSeek request failed: ${this.describeError(error)}`);
      return null;
    }
  }

  /** Текущее потребление DeepSeek за сутки (для админки). */
  public get usage(): { requests: number; tokens: number; costUsd: number; peak: boolean } {
    this.rolloverCounters();
    this.syncDailyGauges();
    return {
      requests: this.dailyRequests,
      tokens: this.dailyTokens,
      costUsd: this.dailyCostUsd,
      peak: isDeepSeekPeak(),
    };
  }

  /** Проставляет дневные гейджи (лимит берётся из настроек). */
  private syncDailyGauges(): void {
    metrics.llm.dailyRequests.set(this.dailyRequests);
    metrics.llm.dailyTokens.set(this.dailyTokens);
    metrics.llm.dailyCostUsd.set(this.dailyCostUsd);
    metrics.llm.dailyLimit.set(this.settings.current.dailyRequestLimit);
  }

  /**
   * Проверяет лимиты и занимает слот. Возвращает false, если запрос
   * отправлять нельзя (перегрузка или исчерпан суточный бюджет).
   */
  private tryAcquire(): boolean {
    this.rolloverCounters();

    const limit = this.settings.current.dailyRequestLimit;
    if (limit > 0 && this.dailyRequests >= limit) {
      metrics.llm.limitHits.inc({ reason: 'daily' });
      this.warnBudgetOnce(`DeepSeek daily request limit reached (${this.dailyRequests}/${limit})`);
      return false;
    }

    if (this.activeRequests >= TROLL_MAX_CONCURRENT_REQUESTS) {
      metrics.llm.limitHits.inc({ reason: 'concurrency' });
      this.warnBudgetOnce(
        `DeepSeek concurrency limit reached (${this.activeRequests}/${TROLL_MAX_CONCURRENT_REQUESTS})`
      );
      return false;
    }

    this.activeRequests += 1;
    this.dailyRequests += 1;
    metrics.llm.activeRequests.set(this.activeRequests);
    this.syncDailyGauges();
    return true;
  }

  /**
   * Пишет в лог промпт и данные запроса, чтобы можно было разобрать поведение
   * модели. Системный промпт (длинный и неизменный) выводится один раз за
   * процесс — так удобно проверить, какая версия промпта задеплоена.
   */
  private logPrompt(messages: DeepSeekMessage[], tag = ''): void {
    const system = messages.find((message) => message.role === 'system')?.content;
    if (system && !this.loggedPrompts.has(system)) {
      this.loggedPrompts.add(system);
      this.logger.debug(`${tag}LLM-промпт (${system.length} символов): ${this.flatten(system)}`);
    }

    const payload = messages
      .filter((message) => message.role !== 'system')
      .map((message) => message.content)
      .join('\n---\n');
    this.logger.debug(`${tag}LLM-данные (${payload.length} символов): ${this.flatten(payload)}`);
  }

  /** Текст одним рядом без переносов — чтобы запись лога не разваливалась. */
  private flatten(text: string): string {
    return text.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    metrics.llm.activeRequests.set(this.activeRequests);
  }

  /**
   * Учитывает токены ответа, стоимость по тарифу модели и разбивку по кэшу.
   * DeepSeek отдаёт `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` —
   * они в разы дешевле/дороже, поэтому считаем их раздельно.
   */
  private recordUsage(raw: unknown, model = this.config.deepseekModel): void {
    const usage = (raw ?? {}) as {
      total_tokens?: unknown;
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_cache_hit_tokens?: unknown;
      prompt_cache_miss_tokens?: unknown;
    };

    const total = Number(usage.total_tokens);
    if (Number.isFinite(total) && total > 0) {
      this.dailyTokens += total;
      metrics.llm.tokens.inc({ model, type: 'total' }, total);
      metrics.llm.dailyTokens.set(this.dailyTokens);
    }

    const promptTokens = this.toCount(usage.prompt_tokens);
    const completionTokens = this.toCount(usage.completion_tokens);
    const cacheHitTokens = this.toCount(usage.prompt_cache_hit_tokens);
    const cacheMissTokens = this.toCount(usage.prompt_cache_miss_tokens);

    if (promptTokens) {
      metrics.llm.tokens.inc({ model, type: 'prompt' }, promptTokens);
    }
    if (completionTokens) {
      metrics.llm.tokens.inc({ model, type: 'completion' }, completionTokens);
    }
    if (cacheHitTokens) {
      metrics.llm.tokens.inc({ model, type: 'cache_hit' }, cacheHitTokens);
    }
    if (cacheMissTokens) {
      metrics.llm.tokens.inc({ model, type: 'cache_miss' }, cacheMissTokens);
    }

    if (!promptTokens && !completionTokens) {
      return;
    }

    const cost = estimateCostUsd(
      model,
      { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens },
      { tariff: this.priceOverride }
    );
    this.dailyCostUsd += cost;
    metrics.llm.costUsd.inc({ model }, cost);
    metrics.llm.dailyCostUsd.set(this.dailyCostUsd);
  }

  /** Значение токенов из ответа API, отсекает мусор и отрицательные числа. */
  private toCount(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * Свой тариф из env (если заданы все три цены). Нужен, чтобы обновить
   * расценки без правки кода, когда DeepSeek меняет прайс.
   */
  private get priceOverride(): DeepSeekTariff | undefined {
    const cacheHitInput = this.config.deepseekPriceCacheHit;
    const cacheMissInput = this.config.deepseekPriceCacheMiss;
    const output = this.config.deepseekPriceOutput;

    if (cacheHitInput === undefined || cacheMissInput === undefined || output === undefined) {
      return undefined;
    }

    return { cacheHitInput, cacheMissInput, output };
  }

  /** Сбрасывает суточные счётчики при смене даты (UTC). */
  private rolloverCounters(): void {
    const key = this.todayKey();
    if (key !== this.dailyKey) {
      this.dailyKey = key;
      this.dailyRequests = 0;
      this.dailyTokens = 0;
      this.dailyCostUsd = 0;
      this.syncDailyGauges();
    }
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Логирует предупреждение о лимите не чаще раза в минуту, чтобы не залить лог. */
  private warnBudgetOnce(message: string): void {
    const now = Date.now();
    if (now - this.lastBudgetWarnAt < 60000) {
      return;
    }
    this.lastBudgetWarnAt = now;
    this.logger.warn(message);
  }

  private describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (
        status === undefined &&
        (error.code === 'ECONNABORTED' || /abort|timeout/i.test(error.message))
      ) {
        return `таймаут ${Math.round(TROLL_LLM_TIMEOUT_MS / 1000)}с`;
      }
      if (status !== undefined && status >= 500) {
        return `ошибка на стороне DeepSeek (status ${status})`;
      }
      const code = error.code ? `, код ${error.code}` : '';
      return `${error.message}${status !== undefined ? ` (status ${status})` : ''}${code}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
