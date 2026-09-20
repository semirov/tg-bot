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
