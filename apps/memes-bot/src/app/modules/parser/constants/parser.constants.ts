/** Идентификатор singleton-строки настроек парсера (как у тролля: id=1). */
export const PARSER_SETTINGS_ID = 1;

/** Статусы источника в реестре. */
export enum SourceStatus {
  ACTIVE = 'active',
  WEB_ONLY = 'web_only',
  DISABLED = 'disabled',
}

/** Категория источника/кандидата. */
export enum SourceCategory {
  MEMES = 'memes',
  CRINGE = 'cringe',
}

/** Статусы кандидата-источника в discovery. */
export enum CandidateVerdict {
  PENDING = 'pending',
  READY = 'ready',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/** Происхождение кандидата. */
export enum CandidateOrigin {
  CROSS_FWD = 'cross_fwd',
  CROSS_LINK = 'cross_link',
  MANUAL = 'manual',
  IMPORT = 'import',
}

/** Статусы собранного поста. */
export enum ObservedStatus {
  PENDING = 'pending',
  SCORED = 'scored',
  SELECTED = 'selected',
  DELIVERED = 'delivered',
  PUBLISHED = 'published',
  QUEUED = 'queued',
  REJECTED = 'rejected',
  DUPLICATE = 'duplicate',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

/** Стадия оценки кандидата. */
export enum EvalStage {
  PRE = 'pre',
  FINAL = 'final',
}

/** Эмодзи реакций: положительные, отрицательные, «кринжовые». */
export const POSITIVE_REACTIONS = ['🔥', '❤️', '😍', '🤩', '👍', '🎉', '🥰', '⚡'];
export const NEGATIVE_REACTIONS = ['👎', '🤬', '😢'];
export const CRINGE_REACTIONS = ['🤡', '💩'];

/** Префикс callback_data карточки поста парсера. */
export const CARD_CB_PREFIX = 'prs';
/** Префикс callback_data карточки кандидата в админке. */

/** Ограничения Bot API на multipart-загрузку медиа. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Авто-выдача: максимум карточек за один select-цикл (каждые 20 минут).
 * Это лишь «порция»: дневной темп задаёт `dailyLimit` через линейный разгон
 * (`deliveryQuota`), поэтому 200/сутки приходят ровно, а не залпом.
 * Ручное «Ещё 20»/`/more` остаётся добором вне бюджета и использует `DUMP_SIZE`.
 */
export const AUTO_DELIVER_PER_CYCLE = 5;

/**
 * Аварийный порог бэклога предложки: при `>=` останавливаются и авто-выдача, и
 * форс-посты (срабатывает и пауза оценки). Это вентиль от разгона, а не рабочее
 * давление: штатный потолок — ~`dailyLimit × BACKLOG_TTL_DAYS`.
 */
export const QUEUE_EMERGENCY_CAP = 2000;

/** Максимум форс-постов за один select-цикл (форс вне дневного бюджета). */
export const FORCE_PER_CYCLE_CAP = 5;

/**
 * Окно выборки кандидатов для ранжирования: берём топ по `score` (индекс
 * `ix_observed_score`), затем переранжируем в памяти по `rankScore`.
 */
export const RANK_WINDOW = 500;

/** Порог совпадения 64-битного перцептивного хеша для склейки карточек в предложке. */
export const QUEUE_MERGE_SIMILARITY = 0.85;

/**
 * Порог схожести «уже опубликовано» для дедупликации.
 *
 * Значение и обоснование — в shared-модуле, чтобы обсерватория и
 * user-post-management использовали ту же метрику (без зависимости
 * observatory → parser). Здесь — ре-экспорт для существующих импортов.
 */
export { PUBLISHED_DUPLICATE_SIMILARITY } from '../../../shared/constants/duplicate-similarity';

/** Во сколько раз «Насыпать ещё» увеличивает темп выдачи. */
export const BOOST_MULTIPLIER = 4;

/** Через сколько часов доставленная без реакции карточка считается игнором. */
/** Минимум разных каналов с одинаковым медиа для форс-публикации в предложку. */
export const FORCE_MIN_SOURCES = 3;

/** Окно (часы), в котором ищем разошедшийся по каналам пост. */
export const FORCE_WINDOW_HOURS = 48;

/** Глубина истории для нового источника, часов. */
export const SCAN_WINDOW_HOURS = 48;

/** Сколько постов накидывает «Насыпать ещё». */
export const DUMP_SIZE = 20;

/** Минимальная пауза между доборами, минут. */
export const DUMP_COOLDOWN_MINUTES = 5;

/** Максимум постов одного канала за одну выдачу (разнообразие). */
export const DUMP_PER_SOURCE_CAP = 3;

/** TTL карточки в предложке (бэклога), дней: старше — удаляем. */
export const BACKLOG_TTL_DAYS = 7;

/** TTL оценённого пула (SCORED), дней: старше — истекает, не выпрашивается. */
export const POOL_TTL_DAYS = 14;

/** Порог совпадения обложек видео для склейки (строже фото). */
export const VIDEO_MERGE_SIMILARITY = 0.92;
export const MAX_VIDEO_BYTES = 45 * 1024 * 1024;

/** Настройки анти-флуда MTProto. */
export const FLOOD_MAX_ATTEMPTS = 3;
export const FLOOD_SINGLE_CAP_SEC = 300;
export const FLOOD_DEADLINE_MS = 10 * 60 * 1000;
export const FLOOD_CUMULATIVE_CAP_SEC = 600;

/** Лимиты discovery за один прогон. */
export const DISCOVERY_WEB_CHECK_PER_RUN = 10;
export const DISCOVERY_CROSS_LIMIT_PER_RUN = 10;
/** Сколько карточек кандидатов показывать за раз в меню. */
