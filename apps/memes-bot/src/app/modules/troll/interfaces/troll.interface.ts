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

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
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
}
