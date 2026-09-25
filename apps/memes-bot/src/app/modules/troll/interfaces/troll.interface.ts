export interface CriminalAssessmentArticle {
  code: string;
  title: string;
  /** За что именно притянули эту статью (коротко). */
  reason?: string;
}

export interface CriminalAssessment {
  probability: number;
  articles: CriminalAssessmentArticle[];
  reason: string;
}

/** Одна статья в раскладке /stat: срок и за что. */
export interface CriminalStatArticle {
  code: string;
  title?: string;
  /** Верхняя граница лишения свободы по статье, лет. */
  years?: number;
  /** За что именно эта статья. */
  reason?: string;
}

/** Оценка суммарного срока по всем сообщениям пользователя за сутки. */
export interface CriminalStat {
  years: number;
  articles: CriminalStatArticle[];
  reason?: string;
}

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

/** Итоги суточного расхода DeepSeek — для отчёта владельцу. */
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
  /** Метка вызова для логов: что именно генерируем (диалог, ревизия, предсказание…). */
  label?: string;
  /** Переопределить модель для вызова (по умолчанию — рабочая модель из настроек). */
  model?: string;
}

/**
 * Настраиваемые в админке параметры «агрессивности» тролль-бота.
 * Вероятности хранятся в диапазоне 0..1.
 */
export interface TrollRuntimeSettings {
  /** Глобальный выключатель бота. */
  enabled: boolean;
  /** Проверка сообщений на признаки состава преступления по УК РФ. */
  criminalEnabled: boolean;
  /** Порог вероятности, начиная с которого бот сообщает о статье. */
  criminalThreshold: number;
  /** Порог, начиная с которого бот пишет «почти наверняка». */
  criminalHighThreshold: number;
  /** Случайные язвительные подколы на обычные сообщения. */
  sarcasmEnabled: boolean;
  /** Вероятность случайного подкола. */
  sarcasmChance: number;
  /** Минимальная пауза между случайными подколами в одном чате, сек. */
  sarcasmCooldownSec: number;
  /** Кривляние: переделывать одно слово из сообщения в матерное. */
  mirrorEnabled: boolean;
  /** Вероятность кривляния. */
  mirrorChance: number;
  /** Минимальная пауза между кривляниями в одном чате, сек. */
  mirrorCooldownSec: number;
  /** Реакции-эмодзи (🤡/💩) на сообщения. */
  reactionEnabled: boolean;
  /** Вероятность реакции-эмодзи. */
  reactionChance: number;
  /** Минимальная пауза между реакциями в одном чате, сек. */
  reactionCooldownSec: number;
  /** Анонсы нового мема в чаты. */
  memeAnnounceEnabled: boolean;
  /** Вероятность анонса мема. */
  memeAnnounceChance: number;
  /** Ответы на обращения к боту (упоминание/ответ). */
  jerkEnabled: boolean;
  /** Реагировать на клички и мат в адрес бота как на обращение. */
  addressReactionEnabled: boolean;
  /** Окно накопления обращений к боту перед общим ответом, сек. */
  jerkBatchWindowSec: number;
  /**
   * Минимальная пауза между ответами на клички/мат в одном чате, сек.
   * На прямые вопросы (реплай, упоминание) не действует — иначе бот «тупит».
   */
  jerkCooldownSec: number;
  /**
   * Пауза без сообщений, после которой начинается новая беседа, мин:
   * реплики из-за паузы в контекст попадают, но бот их не продолжает.
   */
  dialogPauseMin: number;
  /** Минимальная пауза между проверками по УК РФ в одном чате, сек. */
  analyzeCooldownSec: number;
  /** Глобальный лимит запросов к DeepSeek в сутки (защита от перерасхода). */
  dailyRequestLimit: number;
  /** Максимальная длина пользовательского текста, отправляемого в модель. */
  maxInputChars: number;
  /** Самопроверка ответа с переписыванием, если ревизор поставил низкую оценку. */
  selfCheckEnabled: boolean;
  /** Порог оценки ревизора: ниже него ответ переписывается. */
  selfCheckThreshold: number;
  /** Придумывать и обновлять смешные теги участников чата. */
  memberTagsEnabled: boolean;
  /** Вести внутренние биографии участников (долгая память) и подмешивать в диалог. */
  memberBioEnabled: boolean;
  /**
   * Смотреть картинки из чата vision-моделью и класть описание в историю,
   * чтобы бот мог отвечать на вопросы по изображениям. Видео не анализируется.
   */
  visionEnabled: boolean;
  /**
   * Главная модель для текстовых ответов: `true` — deepseek-v4-pro,
   * `false` — deepseek-flash. По умолчанию pro. На разбор картинок не влияет:
   * vision всегда идёт на стабильную модель с распознаванием (flash).
   */
  useProModel: boolean;
}

/** Один предложенный тег участника от модели. */
export interface MemberTagCandidate {
  /** Тег (≤16 символов, без эмодзи). */
  tag: string;
  /** Причина «почему» — матерная, привязанная к темам участника. */
  reason: string;
  /** Релевантность темы участнику и «смешность», 0..1. */
  relevance: number;
}

/** Ответ модели на запрос тегов участника. */
export interface MemberTagSuggestion {
  /** Короткий список ключевых тем участника. */
  topics?: string[];
  /** Кандидаты тега со скором. */
  tags?: MemberTagCandidate[];
}
