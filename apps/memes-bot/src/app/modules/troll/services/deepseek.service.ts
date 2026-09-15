import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { BaseConfigService } from '../../config/base-config.service';
import {
  TROLL_HARD_MAX_TOKENS,
  TROLL_LLM_MAX_RETRIES,
  TROLL_LLM_RETRY_DELAY_MS,
  TROLL_LLM_TIMEOUT_MS,
  TROLL_MAX_CONCURRENT_REQUESTS,
} from '../constants/troll-limits';
import { DeepSeekMessage, DeepSeekOptions } from '../interfaces/troll.interface';
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
    const { temperature = 0.9, maxTokens = 400, json = false } = options;
    const cappedMaxTokens = Math.min(
      Math.max(1, Math.floor(maxTokens)),
      TROLL_HARD_MAX_TOKENS
    );

    if (!this.tryAcquire()) {
      this.logger.debug('DeepSeek: запрос не отправлен (лимит или перегрузка)');
      return '';
    }

    this.logger.debug(
      `DeepSeek: запрос (model=${this.config.deepseekModel}, max_tokens=${cappedMaxTokens}, сообщений=${messages.length}, json=${json}, reasoning_effort=${this.config.deepseekReasoningEffort || 'по умолчанию'})`
    );

    try {
      return await this.requestWithRetry(messages, temperature, cappedMaxTokens, json);
    } finally {
      this.release();
    }
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
    json: boolean
  ): Promise<string> {
    let lastError: unknown;
    const reasoningEffort = this.config.deepseekReasoningEffort;

    for (let attempt = 0; attempt <= TROLL_LLM_MAX_RETRIES; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await this.client.post('/chat/completions', {
          model: this.config.deepseekModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          // deepseek-flash — reasoning-модель: без явного отключения размышления
          // съедают весь max_tokens, и короткие ответы приходят пустыми.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        });

        this.recordUsage(response.data?.usage);

        const limit = this.settings.current.dailyRequestLimit;
        this.logger.log(
          `DeepSeek: ответ за ${Date.now() - startedAt}мс, tokens=${
            response.data?.usage?.total_tokens ?? '?'
          }, сегодня ${formatUsd(this.dailyCostUsd)}, ${this.dailyRequests}/${
            limit > 0 ? limit : '∞'
          } запросов`
        );

        return response.data?.choices?.[0]?.message?.content?.trim() ?? '';
      } catch (error) {
        lastError = error;
        const canRetry = attempt < TROLL_LLM_MAX_RETRIES && this.isRetriable(error);
        this.logger.warn(
          `DeepSeek: запрос не удался за ${Date.now() - startedAt}мс — ${this.describeError(
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

    try {
      return JSON.parse(raw) as T;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        this.logger.warn('DeepSeek returned non-JSON response');
        return null;
      }
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        this.logger.warn('Failed to parse DeepSeek JSON');
        return null;
      }
    }
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
    return {
      requests: this.dailyRequests,
      tokens: this.dailyTokens,
      costUsd: this.dailyCostUsd,
      peak: isDeepSeekPeak(),
    };
  }

  /**
   * Проверяет лимиты и занимает слот. Возвращает false, если запрос
   * отправлять нельзя (перегрузка или исчерпан суточный бюджет).
   */
  private tryAcquire(): boolean {
    this.rolloverCounters();

    const limit = this.settings.current.dailyRequestLimit;
    if (limit > 0 && this.dailyRequests >= limit) {
      this.warnBudgetOnce(`DeepSeek daily request limit reached (${this.dailyRequests}/${limit})`);
      return false;
    }

    if (this.activeRequests >= TROLL_MAX_CONCURRENT_REQUESTS) {
      this.warnBudgetOnce(
        `DeepSeek concurrency limit reached (${this.activeRequests}/${TROLL_MAX_CONCURRENT_REQUESTS})`
      );
      return false;
    }

    this.activeRequests += 1;
    this.dailyRequests += 1;
    return true;
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  /**
   * Учитывает токены ответа, стоимость по тарифу модели и разбивку по кэшу.
   * DeepSeek отдаёт `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` —
   * они в разы дешевле/дороже, поэтому считаем их раздельно.
   */
  private recordUsage(raw: unknown): void {
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
    }

    const promptTokens = this.toCount(usage.prompt_tokens);
    const completionTokens = this.toCount(usage.completion_tokens);
    const cacheHitTokens = this.toCount(usage.prompt_cache_hit_tokens);
    const cacheMissTokens = this.toCount(usage.prompt_cache_miss_tokens);

    if (!promptTokens && !completionTokens) {
      return;
    }

    this.dailyCostUsd += estimateCostUsd(
      this.config.deepseekModel,
      { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens },
      { tariff: this.priceOverride }
    );
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
