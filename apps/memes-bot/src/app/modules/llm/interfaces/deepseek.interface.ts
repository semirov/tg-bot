/**
 * Типы клиента DeepSeek (OpenAI-совместимый Chat Completions).
 * Вынесены из клиента, чтобы сервисы, строящие запросы, не зависели
 * от его реализации.
 */

/**
 * Часть мультимодального сообщения. Текст — обычная строка; изображение —
 * блок `image_url` (base64 data URL или публичная ссылка). Формат совпадает с
 * OpenAI-совместимым Chat Completions, который принимает DeepSeek V4.1 Flash.
 */
export type DeepSeekContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' };
    };

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  /**
   * Строка для обычных текстовых сообщений либо массив частей, когда в
   * сообщении есть изображение. Изображения DeepSeek принимает только в
   * сообщениях роли `user`.
   */
  content: string | DeepSeekContentPart[];
}

/** Суточный расход DeepSeek по одной модели. */
export interface DeepSeekModelUsage {
  /** id модели, например `deepseek-flash` или `deepseek-v4-pro`. */
  model: string;
  /** Успешных ответов модели за сутки. */
  requests: number;
  /** Суммарные токены (prompt + completion). */
  tokens: number;
  /** Стоимость по тарифу модели, $. */
  costUsd: number;
}

/** Итоги суточного расхода DeepSeek — сводка по расходу. */
export interface DeepSeekDailyUsage {
  /** Дата в UTC (YYYY-MM-DD). */
  date: string;
  /** Разбивка по моделям, дороже — выше. */
  models: DeepSeekModelUsage[];
  requests: number;
  tokens: number;
  costUsd: number;
  /** Идёт ли пиковый тариф в момент отчёта. */
  peak: boolean;
}

export interface DeepSeekOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  /** Метка вызова для логов: что именно считаем (классификация канала, префильтр поста…). */
  label?: string;
  /** Переопределить модель для вызова (по умолчанию — рабочая модель из настроек). */
  model?: string;
}
