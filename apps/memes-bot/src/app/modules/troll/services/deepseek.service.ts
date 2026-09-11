import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { BaseConfigService } from '../../config/base-config.service';
import {
  DeepSeekMessage,
  DeepSeekOptions,
} from '../interfaces/troll.interface';

/**
 * Клиент для DeepSeek API (OpenAI-совместимый /chat/completions).
 */
@Injectable()
export class DeepSeekService {
  private readonly logger = new Logger(DeepSeekService.name);
  private readonly client: AxiosInstance;

  constructor(private readonly config: BaseConfigService) {
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
   * Возвращает текстовый ответ модели.
   */
  public async complete(
    messages: DeepSeekMessage[],
    options: DeepSeekOptions = {}
  ): Promise<string> {
    const { temperature = 0.9, maxTokens = 400, json = false } = options;

    const response = await this.client.post('/chat/completions', {
      model: this.config.deepseekModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    });

    return response.data?.choices?.[0]?.message?.content?.trim() ?? '';
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
        this.logger.warn(`DeepSeek returned non-JSON response: ${raw.slice(0, 200)}`);
        return null;
      }
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        this.logger.warn(`Failed to parse DeepSeek JSON: ${raw.slice(0, 200)}`);
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

  private describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const body = error.response?.data;
      return `${error.message}${status ? ` (status ${status})` : ''}${
        body ? ` ${JSON.stringify(body).slice(0, 300)}` : ''
      }`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
