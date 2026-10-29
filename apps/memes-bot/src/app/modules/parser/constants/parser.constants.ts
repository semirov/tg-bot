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
 * Предел попыток доставки строки: после стольких подряд медиа-сбоев (каждый —
 * уже с перечитыванием `file_reference`) пост уходит в `rejected`. Иначе вечно
 * битые строки навсегда занимают голову выборки и цикл отдаёт `delivered=0`.
 */
export const DELIVERY_ATTEMPT_LIMIT = 3;

/**
 * Бэкофф после провалившейся попытки доставки, мс: в этом окне строку не
 * выбираем, чтобы голова очереди не запирала хвост (следующие строки уходят
 * в том же цикле). Пост не «приговор» — просто ждёт следующего окна.
 */
export const DELIVERY_RETRY_BACKOFF_MS = 60 * 60 * 1000;

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

/**
 * Анти-флуд MTProto: пауза по FloodWait держится дедлайном (а не повтором
 * внутри вызова). Вдобавок сбор ограничен token-bucket бюджетом (TGB-125):
 * прод-логи 10/28 показали, что свип реестра «в лоб» (~180–250 вызовов
 * `messages.getHistory`, limit 50, темп 1.5 с, <20 мин) снова включает
 * FloodWait на ~24 ч (`FLOOD_WAIT 85187s`) — парсер живёт 20 мин в сутки.
 */
/** Добавка к дедлайну FloodWait, мс: разводит одновременные вызовы после паузы. */
export const FLOOD_JITTER_MS = 1000;

/**
 * Бюджет сбора: `history` (свип истории, альбомы) — burst 12 вызовов, затем
 * пополнение 20/час; `metadata` (getFullChannel/getEntity/getDialogs) —
 * burst 20, пополнение 20/час. Доставка, скачивание и оценка идут вне бюджета:
 * их голодание запрещено.
 *
 * Retune (TGB-125, follow-up): свип берёт 10 источников за тик (раз в 30 минут,
 * 5 active + 5 web_only), поэтому burst 12 покрывает тик с запасом, а 20/час
 * даёт ~10 свипов в час: `active` — примерно раз в 7–8 ч, `web_only` —
 * раз в ~3–4 суток. Это всё ещё в разы ниже ~180-вызовного всплеска, который
 * заработал суточный FloodWait.
 */
export const MTPROTO_HISTORY_BURST = 12;
export const MTPROTO_HISTORY_PER_HOUR = 20;
/*
 * `metadata`: burst 20 = часовое пополнение (20/час). Часовая порция статистики
 * забирает свои 10 сразу, оставляя 10 на discovery и починку стора сущностей
 * в том же часу; после этого до refill токенов нет — сознательный компромисс:
 * лучше исчерпать полосу к концу часа, чем держать burst 5 и упираться в него
 * на первой же порции (stats работал ~4–5/час вместо 10).
 */
export const MTPROTO_METADATA_BURST = 20;
export const MTPROTO_METADATA_PER_HOUR = 20;

/** Как часто максимум пишем «бюджет исчерпан» по одному bucket, мс (анти-спам лога). */
export const MTPROTO_BUDGET_LOG_INTERVAL_MS = 60 * 1000;

/**
 * Свип истории — ротационная порция, а не весь реестр за раз: 895 источников
 * (78 active + 817 web_only) в фиксированном порядке и были тем самым
 * ~180-вызовным всплеском перед суточным FloodWait.
 */
export const SWEEP_SOURCES_PER_RUN = 10;
/**
 * Квота тира внутри порции свипа: 5 `active` + 5 `web_only`. Без неё 78
 * активных (интервал 4 ч) выедали бы всю порцию, а у web_only нет live-событий —
 * история свипа их единственный канал сбора. Свободные слоты тира забирает
 * другой тир (до общего `SWEEP_SOURCES_PER_RUN`).
 */
export const SWEEP_TIER_QUOTA = 5;
/**
 * Окно чтения первого свипа источника (нет `lastSweepAt`) — как было, 26 ч.
 * Дальше окно считается от `lastSweepAt`: у `web_only` каденс ~3.4 суток, и
 * фиксированные 26 ч теряли бы историю между свипами.
 */
export const SWEEP_FIRST_WINDOW_MS = 26 * 60 * 60 * 1000;
/**
 * Потолок окна дочитывания: свип читает с `lastSweepAt − 1 ч`, но не глубже
 * 7 дней (масштаб `POOL_TTL_DAYS`): без потолка источник, вернувшийся после
 * долгой паузы, заказывал бы гигантскую историю.
 */
export const MAX_SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Перекрытие на границе окна дочитывания (посты на стыке двух свипов), мс. */
export const SWEEP_READ_OVERLAP_MS = 60 * 60 * 1000;
/** Пауза между history-вызовами свипа, мс (с jitter 500 мс через `guard.pace`). */
export const SWEEP_GAP_MS = 4000;
/**
 * Сколько сообщений читает один history-вызов свипа. Упор в лимит означает
 * «в окне есть ещё история»: курсор `lastSweepAt` тогда ставится на дату
 * самого старого прочитанного поста, иначе глубокий бэклог терялся бы.
 */
export const SWEEP_HISTORY_LIMIT = 50;
/** Минимальный интервал повторного свипа: активные — 4 ч. */
export const SWEEP_ACTIVE_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Минимальный интервал повторного свипа: web-only источники — 24 ч. */
export const SWEEP_WEB_ONLY_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Прогон статистики — ротационная порция по `statsUpdatedAt` (NULLS FIRST):
 * полный проход всех источников `getFullChannel` упирался в тот же FloodWait.
 * Порция идёт ежечасно (`20 * * * *`): 10 источников/час = ≤240 за сутки,
 * полный круг 895 источников ≈ 3.7 суток. Полоса `metadata` (20/час) остаётся
 * с запасом на discovery и починку стора сущностей.
 */
export const STATS_SOURCES_PER_RUN = 10;
/** Пауза между источниками в прогоне статистики, мс. */
export const STATS_GAP_MS = 3000;
/** Метка ошибки статистики: по ней часовая ротация откладывает источник. */
export const STATS_ERROR_REASON = 'getFullChannel-failed';
/**
 * Бэкофф источника, чей `getFullChannel` реально упал: пока `lastErrorAt`
 * моложе, источник не попадает в часовую порцию. `statsUpdatedAt` двигается
 * только по результату, поэтому без бэкоффа вечно падающий источник навсегда
 * оставался бы первым в ротации (NULLS FIRST) и жёг бы токен каждый час.
 * 24 ч — интервал самой статистики: повтор не чаще раза в сутки.
 */
export const STATS_ERROR_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** Entity-miss (CHANNEL_INVALID / нет input entity): экспоненциальный бэкофф. */
export const ENTITY_BACKOFF_BASE_MS = 1000;
export const ENTITY_BACKOFF_CAP_MS = 15 * 60 * 1000;

/**
 * Восстановление стора сущностей gramjs после промаха пира: `getDialogs`
 * возвращает `chats`/`users` с access hash-ами, и gramjs кладёт их и в
 * `_entityCache`, и в строки сессии. Лимит ограничивает цену вызова.
 */
export const ENTITY_REFRESH_DIALOG_LIMIT = 200;

/**
 * Не чаще одного refresh-а стора сущностей за окно, мс: промахи приходят
 * пачкой (по всем источникам), а `getDialogs` — дорогой вызов.
 */
export const ENTITY_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Пауза свипа для «мёртвого» пира (промах → успешный refresh → промах), мс.
 * Свип идёт раз в 30 минут, а шаг бэкоффа доходит до 15 минут — без этой паузы
 * пир дёргался бы на каждом свипе. Ставится только когда refresh реально
 * сходил: пропущенный/упавший refresh паркует пир лишь до следующего окна
 * (`ENTITY_REFRESH_COOLDOWN_MS`). Пир возвращается сам: после горизонта один
 * пробный вызов, успех снимает паузу.
 */
export const ENTITY_BROKEN_RETRY_MS = 60 * 60 * 1000;

/** Лимиты discovery за один прогон. */
export const DISCOVERY_WEB_CHECK_PER_RUN = 10;
export const DISCOVERY_CROSS_LIMIT_PER_RUN = 10;
/** Сколько карточек кандидатов показывать за раз в меню. */
