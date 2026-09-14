import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { BaseConfigService } from '../../config/base-config.service';
import { TROLL_HARD_MAX_TOKENS, TROLL_MAX_CONCURRENT_REQUESTS } from '../constants/troll-limits';
import { DeepSeekMessage, DeepSeekOptions } from '../interfaces/troll.interface';
import { TrollSettingsService } from './troll-settings.service';

/**
 * Клиент для DeepSeek API (OpenAI-совместимый /chat/completions).
 *
 * Все вызовы проходят через защиту от перерасхода токенов:
 *  - жёсткий потолок max_tokens на запрос;
 *  - лимит одновременных запросов;
 *  - суточный лимит запросов (настраивается в админке).
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
  private lastBudgetWarnAt = 0;

  constructor(
    private readonly config: BaseConfigService,
    private readonly settings: TrollSettingsService
  ) {
    this.client = axios.create({
      baseURL: this.config.deepseekBaseUrl,
      timeout: 30000,
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
      `DeepSeek: запрос (model=${this.config.deepseekModel}, max_tokens=${cappedMaxTokens}, сообщений=${messages.length}, json=${json})`
    );
    const startedAt = Date.now();

    try {
      const response = await this.client.post('/chat/completions', {
        model: this.config.deepseekModel,
        messages,
        temperature,
        max_tokens: cappedMaxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      });

      this.recordTokens(response.data?.usage?.total_tokens);

      const limit = this.settings.current.dailyRequestLimit;
      this.logger.log(
        `DeepSeek: ответ за ${Date.now() - startedAt}мс, tokens=${
          response.data?.usage?.total_tokens ?? '?'
        }, сегодня ${this.dailyRequests}/${limit > 0 ? limit : '∞'}`
      );

      return response.data?.choices?.[0]?.message?.content?.trim() ?? '';
    } finally {
      this.release();
    }
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
  public get usage(): { requests: number; tokens: number } {
    this.rolloverCounters();
    return { requests: this.dailyRequests, tokens: this.dailyTokens };
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

  private recordTokens(total: unknown): void {
    const parsed = Number(total);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.dailyTokens += parsed;
    }
  }

  /** Сбрасывает суточные счётчики при смене даты (UTC). */
  private rolloverCounters(): void {
    const key = this.todayKey();
    if (key !== this.dailyKey) {
      this.dailyKey = key;
      this.dailyRequests = 0;
      this.dailyTokens = 0;
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
      return `${error.message}${status ? ` (status ${status})` : ''}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
