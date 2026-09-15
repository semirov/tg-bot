/**
 * Жёсткие лимиты безопасности LLM-интеграции. Это НЕ настройки админки:
 * они не должны ослабляться, чтобы бота нельзя было «разогнать» на перерасход
 * токенов или вывести из строя через слишком длинный ввод.
 */

/** Абсолютный потолок max_tokens на один запрос к DeepSeek. */
export const TROLL_HARD_MAX_TOKENS = 800;

/** Абсолютный потолок длины пользовательского текста перед отправкой в модель. */
export const TROLL_HARD_MAX_INPUT_CHARS = 3000;

/** Максимум одновременных запросов к DeepSeek на процесс. */
export const TROLL_MAX_CONCURRENT_REQUESTS = 4;

/** Таймаут одного запроса к DeepSeek, мс. */
export const TROLL_LLM_TIMEOUT_MS = 45000;

/** Сколько раз повторять запрос при сетевой ошибке/таймауте. */
export const TROLL_LLM_MAX_RETRIES = 1;

/** Пауза перед повтором запроса, мс. */
export const TROLL_LLM_RETRY_DELAY_MS = 1500;

/** Потолок длины ответа-подкола (сарказм/«мудак»), символов. */
export const TROLL_MAX_REPLY_CHARS = 400;

/** Потолок длины пояснения в ответе про статью УК РФ, символов. */
export const TROLL_MAX_CRIMINAL_REASON_CHARS = 600;

/** Потолок длины названия статьи УК РФ, символов. */
export const TROLL_MAX_CRIMINAL_TITLE_CHARS = 120;

/** id синглтон-строки настроек. */
export const TROLL_SETTINGS_ID = 1;

/** Максимум сообщений одного пользователя для /stat. */
export const TROLL_STAT_MAX_MESSAGES_PER_USER = 50;

/** Потолок длины текста пользователя для /stat, символов. */
export const TROLL_STAT_MAX_CHARS = 4000;

/** Пауза между вызовами /stat в одном чате, сек. */
export const TROLL_STAT_COOLDOWN_SEC = 60;

/** Через сколько часов можно снова запросить /future. */
export const TROLL_FUTURE_COOLDOWN_HOURS = 12;

/** Вероятность, что предсказание будет добрым (иначе — плохое). */
export const TROLL_FUTURE_GOOD_CHANCE = 0.01;

/** Потолок длины предсказания /future, символов (грубая защита от «разгона», не стилевой лимит). */
export const TROLL_FUTURE_MAX_CHARS = 400;

/** Сколько часов хранить предсказания (потом чистим). */
export const TROLL_FUTURE_STORE_HOURS = 24;

/** После скольких запросов подряд бот меняет предсказание на обидное. */
export const TROLL_FUTURE_ANGRY_AFTER = 2;

/**
 * Сколько прошлых предсказаний чата передавать модели, чтобы она не повторяла
 * ни тему, ни приём (промпт статeless, без этого списка он зацикливается).
 */
export const TROLL_FUTURE_AVOID_REPEAT = 6;

/** Пауза между вызовами /meme в одном чате, сек. */
export const TROLL_MEME_COOLDOWN_SEC = 60 * 60;

/** Сколько последних мемов брать в пул для /meme. */
export const TROLL_MEME_POOL_SIZE = 50;

/** Сколько попыток копирования делаем, прежде чем сдаться. */
export const TROLL_MEME_MAX_ATTEMPTS = 5;

/** Пауза между вызовами /sumarize в одном чате (общий кулдаун на весь чат), сек. */
export const TROLL_SUMMARY_COOLDOWN_SEC = 60 * 60;

/** Сколько последних сообщений брать в саммари. */
export const TROLL_SUMMARY_MAX_MESSAGES = 400;

/**
 * Сколько последних реплик чата брать в саммари, если окно «с прошлого раза»
 * оказалось пустым (лучше пересказать хоть что-то, чем отказать).
 */
export const TROLL_SUMMARY_FALLBACK_MESSAGES = 60;

/** Потолок длины входного текста для саммари, символов. */
export const TROLL_SUMMARY_MAX_CHARS = 16000;

/** Потолок max_tokens для запроса саммари. */
export const TROLL_SUMMARY_MAX_TOKENS = 700;

/** Потолок длины ответа-саммари, символов. */
export const TROLL_SUMMARY_MAX_REPLY_CHARS = 700;

/** Максимум сообщений, накапливаемых в одном окне «мудак»-ответа. */
export const TROLL_MAX_BATCH_MESSAGES = 20;

/**
 * Абсолютный потолок числа реплик в контексте беседы.
 * Отделён от суток: сам контекст — это вся беседа за 24 часа (TTL истории),
 * а тут только страховка от совсем бесконечного чата.
 */
export const TROLL_CONTEXT_MAX_TURNS = 1500;

/**
 * Абсолютный потолок длины расшифровки беседы, символов.
 * Расчитан на то, чтобы суточная беседа влезала целиком (~20 тыс. токенов
 * при 48 тыс. символов), и остаётся далеко от границ контекста deepseek-chat.
 */
export const TROLL_CONTEXT_MAX_CHARS = 48000;

/** Максимальная длина одной реплики в истории, символов. */
export const TROLL_HISTORY_MAX_CHARS = 3000;

/** Сколько часов хранить историю переписки, потом удаляем. */
export const TROLL_HISTORY_TTL_HOURS = 24;

/** Как часто чистить старую историю. */
export const TROLL_HISTORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Потолок max_tokens для диалогового ответа. */
export const TROLL_JERK_MAX_TOKENS = 300;

/** Максимальная длина переделанного слова (кривляние), символов. */
export const TROLL_MIRROR_MAX_CHARS = 32;

/** Минимальная длина слова, которое можно переделать. */
export const TROLL_MIRROR_MIN_WORD_LEN = 4;
