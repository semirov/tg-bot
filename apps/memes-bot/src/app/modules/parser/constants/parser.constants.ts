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
export const CANDIDATE_CB_PREFIX = 'prsc';

/** Ограничения Bot API на multipart-загрузку медиа. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Темп доставки: сколько карточек селектор отправляет за один прогон (20 мин). */
export const SELECT_LIMIT_PER_RUN = 15;

/** Порог совпадения 64-битного перцептивного хеша для склейки карточек в предложке. */
export const QUEUE_MERGE_SIMILARITY = 0.85;

/** Во сколько раз «Насыпать ещё» увеличивает темп выдачи. */
export const BOOST_MULTIPLIER = 4;

/** Через сколько часов доставленная без реакции карточка считается игнором. */
export const IGNORED_AFTER_HOURS = 48;

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

/** Если карточек в предложке больше — оценку приостанавливаем. */
export const EVAL_PAUSE_BACKLOG = 400;

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
export const DISCOVERY_REVIEW_LIMIT = 8;
