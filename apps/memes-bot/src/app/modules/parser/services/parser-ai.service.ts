import { Injectable } from '@nestjs/common';
import { DeepSeekService } from '../../troll/services/deepseek.service';
import { ParserSettingsService } from './parser-settings.service';

/** Вердикт AI по каналу-кандидату. */
export interface ChannelAiVerdict {
  category: 'memes' | 'cringe' | 'topical' | 'other';
  relevance: number;
  nsfw: boolean;
  reason?: string;
}

/** Вердикт AI по посту (префильтр мусора). */
export interface PostAiVerdict {
  isAd: boolean;
  nsfw: boolean;
  isCringe: boolean;
  reason?: string;
}

/**
 * AI-ступень парсера: DeepSeek (текстовая модель) классифицирует каналы и
 * подписи постов. Работает только за тумблером aiEnabled; лимиты и бюджет —
 * встроенные механизмы DeepSeekService.
 */
@Injectable()
export class ParserAiService {
  constructor(
    private readonly deepseek: DeepSeekService,
    private readonly settings: ParserSettingsService
  ) {}

  public get enabled(): boolean {
    return this.settings.current.aiEnabled;
  }

  /** Классификация канала-кандидата по тайтлу и последним текстам. */
  public async classifyChannel(
    title: string | null,
    recentTexts: ReadonlyArray<string>
  ): Promise<ChannelAiVerdict | null> {
    if (!this.enabled) return null;
    const system =
      'Ты классифицируешь Telegram-каналы для агрегатора мемов. Ответь строго JSON: ' +
      '{"category":"memes|cringe|topical|other","relevance":0..1,"nsfw":true|false,"reason":"кратко"}.' +
      ' relevance — насколько канал подходит для агрегатора юмора/мемов (не новости, не реклама). ' +
      ' cringe = намеренно плохой/токсичный юмор. nsfw = 18+.';
    const user = `Канал: ${title ?? '(без названия)'}\nПоследние посты:\n${recentTexts
      .slice(0, 10)
      .map((text, index) => `${index + 1}. ${text.slice(0, 200)}`)
      .join('\n')}`;

    const parsed = await this.deepseek.completeJson<ChannelAiVerdict>(system, user, {
      label: 'parser:channel',
      maxTokens: 200,
      temperature: 0.2,
    });
    if (!parsed) return null;
    return {
      category: ['memes', 'cringe', 'topical', 'other'].includes(parsed.category)
        ? parsed.category
        : 'other',
      relevance: clamp01(parsed.relevance),
      nsfw: parsed.nsfw === true,
      reason: parsed.reason,
    };
  }

  /**
   * Префильтр поста: реклама/NSFW в подписи. Возвращает строку-причину
   * отклонения или null (пропускаем дальше).
   */
  public async rejectPostIfTrash(caption: string | null): Promise<string | null> {
    if (!this.enabled) return null;
    if (!caption || caption.length < 4) return null;

    const system =
      'Ты фильтр контента агрегатора мемов. Ответь строго JSON: ' +
      '{"isAd":true|false,"nsfw":true|false,"isCringe":true|false,"reason":"кратко"}.' +
      ' isAd — подпись содержит рекламу/промо/призывы перейти; nsfw — 18+ без контекста мемов.';
    const parsed = await this.deepseek.completeJson<PostAiVerdict>(system, caption.slice(0, 800), {
      label: 'parser:post',
      maxTokens: 120,
      temperature: 0.2,
    });
    if (!parsed) return null;
    if (parsed.isAd) return 'ai:ad';
    if (parsed.nsfw) return 'ai:nsfw';
    return null;
  }

  /** Заглушка для будущей кринж-классификации карточек. */
  public async isCringePost(caption: string | null): Promise<boolean> {
    if (!this.enabled || !caption) return false;
    const parsed = await this.deepseek.completeJson<PostAiVerdict>(
      'Ответь JSON: {"isCringe":true|false}. isCringe = пост выглядит как намеренно кринжовый/плохой юмор.',
      caption.slice(0, 800),
      { label: 'parser:cringe', maxTokens: 80, temperature: 0.2 }
    );
    return parsed?.isCringe === true;
  }
}

const clamp01 = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};
