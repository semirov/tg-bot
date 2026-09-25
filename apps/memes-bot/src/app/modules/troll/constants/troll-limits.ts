/**
 * Жёсткие лимиты безопасности LLM-интеграции. Это НЕ настройки админки:
 * они не должны ослабляться, чтобы бота нельзя было «разогнать» на перерасход
 * токенов или вывести из строя через слишком длинный ввод.
 *
 * Объём контекста ограничен временем: бот помнит беседу за TROLL_HISTORY_TTL_HOURS
 * (24 часа) целиком, без рабочих лимитов по репликам и символам. Записи старше TTL
 * удаляются, чтобы контекст не утонул. Константы TROLL_CONTEXT_MAX_* — аварийный
 * предохранитель от патологического флуда, а не рабочий лимит.
 */

/** Абсолютный потолок max_tokens на один запрос к DeepSeek. */
export const TROLL_HARD_MAX_TOKENS = 1200;

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
export const TROLL_STAT_MAX_MESSAGES_PER_USER = 500;

/** Потолок длины текста пользователя для /stat, символов. */
export const TROLL_STAT_MAX_CHARS = 200000;

/** Пауза между вызовами /stat в одном чате, сек. */
export const TROLL_STAT_COOLDOWN_SEC = 60;

/** Через сколько часов можно снова запросить /future. */
export const TROLL_FUTURE_COOLDOWN_HOURS = 12;

/** Вероятность, что предсказание будет добрым (иначе — плохое). */
export const TROLL_FUTURE_GOOD_CHANCE = 0.01;

/** Потолок длины предсказания /future, символов (грубая защита от «разгона», не стилевой лимит). */
export const TROLL_FUTURE_MAX_CHARS = 400;

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

/**
 * Аварийный потолок числа реплик для саммари. Окно пересказа — вся история за
 * TTL (24 часа), поэтому лимит высокий: это предохранитель от патологического
 * флуда, а не рабочий ограничитель. Реальный ограничитель объёма — TROLL_SUMMARY_MAX_CHARS.
 */
export const TROLL_SUMMARY_MAX_MESSAGES = 5000;

/**
 * Потолок длины входного текста для саммари, символов. Равен аварийному
 * потолку контекста диалога (TROLL_CONTEXT_MAX_CHARS), который уже проверен
 * на боевой модели: столько символов + max_tokens укладываются в её контекст.
 * Расшифровку собираем от свежих реплик, так что усечение теряет только старое.
 */
export const TROLL_SUMMARY_MAX_CHARS = 200000;

/** Потолок max_tokens для запроса саммари. */
export const TROLL_SUMMARY_MAX_TOKENS = 1000;

/** Потолок длины ответа-саммари, символов. */
export const TROLL_SUMMARY_MAX_REPLY_CHARS = 2000;

/** Максимум сообщений, накапливаемых в одном окне «мудак»-ответа. */
export const TROLL_MAX_BATCH_MESSAGES = 20;

/**
 * Аварийный потолок числа реплик в контексте беседы. Не рабочий лимит:
 * рабочий ограничитель — только TTL истории (24 часа). Нужен, чтобы
 * патологический флуд не уронил запрос.
 */
export const TROLL_CONTEXT_MAX_TURNS = 5000;

/**
 * Аварийный потолок длины расшифровки беседы, символов (~70 тыс. токенов).
 * Тоже не рабочий лимит: суточная беседа в него укладывается с запасом.
 */
export const TROLL_CONTEXT_MAX_CHARS = 200000;

/** Максимальная длина одной реплики в истории, символов. */
export const TROLL_HISTORY_MAX_CHARS = 3000;

/** Сколько часов хранить историю переписки: всю беседу за сутки, потом вычищаем. */
export const TROLL_HISTORY_TTL_HOURS = 24;

/** Потолок max_tokens для диалогового ответа. */
export const TROLL_JERK_MAX_TOKENS = 300;

/**
 * Потолок max_tokens для описания изображения (vision). Модель возвращает
 * подробный JSON (категория, мем-шаблон, истинный смысл), поэтому бюджет
 * заметно больше, чем на реплику, но всё равно небольшой.
 */
export const TROLL_VISION_MAX_TOKENS = 1000;

/** Максимальная длина описания изображения, которое кладём в историю, символов. */
export const TROLL_VISION_MAX_CHARS = 800;

/**
 * Минимальная уверенность vision-модели в разборе, при которой бот может по
 * своей воле прокомментировать картинку (случайный подкол). Ниже — молчит.
 */
export const TROLL_VISION_CONFIDENCE_MIN = 0.6;

/**
 * Расписание отчёта о расходе DeepSeek: каждый день в 23:55 (время процесса).
 * Отчёт уходит владельцу в личку и содержит суточные токены/стоимость по моделям.
 */
export const TROLL_USAGE_REPORT_CRON = '55 23 * * *';

/** Максимальная длина переделанного слова (кривляние), символов. */
export const TROLL_MIRROR_MAX_CHARS = 32;

/**
 * Самопроверка ответа: сколько всего попыток (первая + переписывания).
 * Включается настройкой админки «Проверка ответа».
 */
export const TROLL_SELF_CHECK_MAX_ATTEMPTS = 3;

/**
 * Сколько символов переписки отдавать ревизору. Только хвост, чтобы не жечь
 * токены, но 2000 символов мало: просьба собеседника часто остаётся за обрезом,
 * и ревизор принимал ответ за выдумку («в переписке такого не было»).
 */
export const TROLL_SELF_CHECK_CONTEXT_CHARS = 6000;

/** Потолок max_tokens для ответа ревизора. */
export const TROLL_SELF_CHECK_MAX_TOKENS = 600;

/** Минимальная длина слова, которое можно переделать. */
export const TROLL_MIRROR_MIN_WORD_LEN = 4;

/**
 * Разбор дефекта (владелец прислал неудачный ответ бота).
 * Диагностика идёт на старшей модели: операция редкая и только для владельца,
 * а разбор качества требует модели помощнее рабочей.
 */
export const TROLL_DIAGNOSTIC_MODEL = 'deepseek-v4-pro';

/** Потолок max_tokens для диагностики дефекта. */
export const TROLL_DIAGNOSTIC_MAX_TOKENS = 900;

/**
 * Сколько реплик беседы показывать модели в диагностике и хранить в дефекте:
 * нужен кусок переписки вокруг ответа, а не вся сутка.
 */
export const TROLL_DEFECT_CONTEXT_TURNS = 40;

/**
 * Окно поиска исходного ответа по времени форварда: запись в базу делается
 * сразу после отправки, так что расхождение исчисляется секундами.
 */
export const TROLL_DEFECT_TIME_WINDOW_MS = 10 * 60 * 1000;

/** Сколько ответов бота вообще просматривать при поиске без известной даты. */
export const TROLL_DEFECT_SEARCH_LIMIT = 400;

/** Потолок длины контекста беседы в дефекте (и в запросе на диагностику). */
export const TROLL_DEFECT_CONTEXT_CHARS = 12000;

/** Допустимые уровни серьёзности дефекта (ответ диагностики). */
export const TROLL_DEFECT_SEVERITIES = ['low', 'medium', 'high'];

/**
 * Теги участников чата (`setChatMemberTag`).
 * Жёсткий лимит Telegram: 0–16 символов, эмодзи запрещены.
 */
export const TROLL_MEMBER_TAG_MAX_CHARS = 16;

/**
 * Раз в сколько сообщений участника пересматривать его тег: на 10-е, 20-е и т.д.
 * Событийно, без крона; контекст — вся история за сутки.
 */
export const TROLL_MEMBER_TAG_BATCH_MESSAGES = 10;

/** Сколько последних реплик участника отправлять модели. */
export const TROLL_MEMBER_TAG_MAX_MESSAGES = 40;

/** Потолок длины расшифровки реплик участника, символов. */
export const TROLL_MEMBER_TAG_TRANSCRIPT_CHARS = 4000;

/** Потолок max_tokens для запроса тегов. */
export const TROLL_MEMBER_TAG_MAX_TOKENS = 500;

/** Не чаще раза в сутки на человека (антифлуд). */
export const TROLL_MEMBER_TAG_COOLDOWN_HOURS = 24;

/** Максимум кандидатов-тегов, которые просим у модели. */
export const TROLL_MEMBER_TAG_CANDIDATES = 5;

/** Сколько занятых в чате тегов передавать модели, чтобы не повторяться. */
export const TROLL_MEMBER_TAG_OCCUPIED_MAX = 30;

/** Потолок max_tokens для промта-объявления о наречении. */
export const TROLL_MEMBER_TAG_ANNOUNCE_MAX_TOKENS = 200;

/** Потолок длины объявления о наречении, символов. */
export const TROLL_MEMBER_TAG_ANNOUNCE_MAX_CHARS = 250;

/**
 * Биографии участников (внутренняя долгая память, per-chat).
 * Хранение и впрыск — не более TROLL_MEMBER_BIO_MAX_CHARS символов.
 */
export const TROLL_MEMBER_BIO_MAX_CHARS = 1000;

/**
 * Через сколько новых реплик участника обновлять досье. По эксперименту:
 * каждые ~20 сообщений — та же полнота, что каждые 10, но вдвое дешевле.
 */
export const TROLL_MEMBER_BIO_UPDATE_EVERY = 20;

/** Минимальный интервал между обновлениями одного досье, мс (антифлуд). */
export const TROLL_MEMBER_BIO_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** Сколько свежих реплик участника отдавать модели за одно обновление. */
export const TROLL_MEMBER_BIO_MAX_MESSAGES = 40;

/** Потолок длины расшифровки реплик для извлечения фактов, символов. */
export const TROLL_MEMBER_BIO_TRANSCRIPT_CHARS = 8000;

/** Потолок max_tokens извлечения фактов. */
export const TROLL_MEMBER_BIO_MAX_TOKENS = 800;

/** Максимум фактов, извлекаемых за одно обновление. */
export const TROLL_MEMBER_BIO_MAX_FACTS = 6;

/** Сколько подтверждений делают факт ядром. */
export const TROLL_MEMBER_BIO_CORE_MIN = 2;

/** Порог похожести фактов при слиянии (доля совпавших слов). */
export const TROLL_MEMBER_BIO_SIMILARITY = 0.6;

/** Вес памяти: старт, прибавка за подтверждение, потолок, порог вымывания. */
export const TROLL_MEMBER_BIO_WEIGHT_INITIAL = 1;
export const TROLL_MEMBER_BIO_WEIGHT_BOOST = 1;
export const TROLL_MEMBER_BIO_WEIGHT_MAX = 4;
export const TROLL_MEMBER_BIO_DROP_THRESHOLD = 0.3;

/** Базовый и максимальный период полураспада факта, часы. */
export const TROLL_MEMBER_BIO_HALF_LIFE_BASE_HOURS = 6;
export const TROLL_MEMBER_BIO_HALF_LIFE_MAX_HOURS = 336; // 14 суток

/** Сколько досье (участников) подмешивать в диалог и их суммарный потолок. */
export const TROLL_MEMBER_BIO_INJECT_MAX_USERS = 5;
export const TROLL_MEMBER_BIO_INJECT_MAX_CHARS = 1600;

/** Canary-строка внутри блока памяти: появление в ответе = утечка. */
export const TROLL_MEMBER_BIO_CANARY = 'ВНУТР_БИО_7F3A9E21';

/** Минимальная длина дословного совпадения с фактом (слов), считающаяся утечкой. */
export const TROLL_MEMBER_BIO_LEAK_NGRAM = 5;

/**
 * Взвешивание диалогового контекста по свежести.
 * Свежий хвост — дословно, чуть постарше — сжимаем, совсем старое — отбрасываем.
 */
export const TROLL_DIALOG_HOT_MESSAGES = 20;
export const TROLL_DIALOG_HOT_MINUTES = 30;
export const TROLL_DIALOG_WARM_MINUTES = 120;
export const TROLL_DIALOG_WARM_CHARS = 60;
