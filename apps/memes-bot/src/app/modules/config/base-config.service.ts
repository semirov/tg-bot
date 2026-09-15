import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BaseConfigService {
  constructor(private configService: ConfigService) {}

  get botToken(): string {
    return this.configService.getOrThrow('BOT_TOKEN');
  }

  get ownerId(): number {
    return +this.configService.getOrThrow<string>('BOT_OWNER_ID');
  }

  get memeChanelId(): number {
    return +this.configService.getOrThrow<string>('MANAGED_CHANNEL');
  }

  get bestMemeChanelId(): number {
    return +this.configService.getOrThrow<string>('BEST_MANAGED_CHANNEL');
  }

  get userRequestMemeChannel(): number {
    return +this.configService.getOrThrow<string>('USER_REQUEST_CHANNEL');
  }

  get cringeMemeChannelId(): number {
    return +this.configService.getOrThrow<string>('CRINGE_CHANNEL');
  }

  get observerChannel(): number {
    return +this.configService.getOrThrow<string>('OBSERVER_CHANNEL');
  }

  get databaseHost(): string {
    return this.configService.getOrThrow<string>('DATABASE_HOST');
  }

  get databasePort(): number {
    return +this.configService.getOrThrow<string>('DATABASE_PORT');
  }

  get useSSL(): boolean {
    return this.configService.getOrThrow<string>('USE_SSL') === 'true';
  }

  get databaseUsername(): string {
    return this.configService.getOrThrow<string>('DATABASE_USERNAME');
  }

  get databasePassword(): string {
    return this.configService.getOrThrow<string>('DATABASE_PASSWORD');
  }

  get databaseName(): string {
    return this.configService.getOrThrow<string>('DATABASE_NAME');
  }

  get appApiId(): number {
    return +this.configService.getOrThrow<string>('APP_API_ID');
  }

  get appApiHash(): string {
    return this.configService.getOrThrow<string>('APP_API_HASH');
  }

  get tgEnv(): 'prod' | 'test' {
    return this.configService.getOrThrow<'prod' | 'test'>('TG_ENV');
  }

  get s3Endpoint(): string {
    return this.configService.getOrThrow<string>('S3_ENDPOINT');
  }

  get s3Region(): string {
    return this.configService.getOrThrow<string>('S3_REGION');
  }

  get s3Bucket(): string {
    return this.configService.getOrThrow<string>('S3_BUCKET');
  }

  get s3AccessKeyId(): string {
    return this.configService.getOrThrow<string>('S3_ACCESS_KEY_ID');
  }

  get s3SecretAccessKey(): string {
    return this.configService.getOrThrow<string>('S3_SECRET_ACCESS_KEY');
  }

  get monitorBotToken(): string {
    return this.configService.getOrThrow<string>('MONITOR_BOT_TOKEN');
  }

  get monitorMainChannel(): string {
    return this.configService.getOrThrow<string>('MONITOR_MAIN_CHANNEL');
  }

  get monitorBestChannel(): string {
    return this.configService.getOrThrow<string>('MONITOR_BEST_CHANNEL');
  }

  get mattermostBaseUrl(): string {
    return this.configService.get<string>('MATTERMOST_BASE_URL') || 'https://time.tbank.ru';
  }

  get mattermostToken(): string {
    return this.configService.get<string>('MATTERMOST_TOKEN') || 'wkthpwfpstrp3kt1xfau576q1y';
  }

  get mattermostChannelId(): string {
    return this.configService.get<string>('MATTERMOST_CHANNEL_ID') || 'cxbgr1bbi3ypzfc6nc53womtph';
  }

  /**
   * Публичный base URL для изображений (например S3 бакет).
   * Используется для вставки картинок в посты Time через Markdown.
   */
  get mattermostImageBaseUrl(): string {
    return this.configService.get<string>('MATTERMOST_IMAGE_BASE_URL') || '';
  }

  /**
   * Ключ DeepSeek. Секретов в репозитории быть не должно, поэтому ключа-дефолта
   * здесь нет: без переменной окружения LLM-функции тролля просто не работают
   * (см. DeepSeekService — он честно скажет об этом в лог).
   */
  get deepseekApiKey(): string {
    return this.configService.get<string>('DEEPSEEK_API_KEY') ?? '';
  }

  get deepseekBaseUrl(): string {
    return this.configService.get<string>('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com';
  }

  get deepseekModel(): string {
    return this.configService.get<string>('DEEPSEEK_MODEL') || 'deepseek-flash';
  }

  /**
   * Режим «размышлений» модели: none | minimal | low | medium | high | xhigh | max.
   *
   * По умолчанию выключен: deepseek-flash — reasoning-модель, и при коротких
   * бюджетах (24–80 токенов на кривляние, отказ и предсказание) размышления
   * съедают весь max_tokens, а ответ приходит пустым.
   */
  get deepseekReasoningEffort(): string {
    return this.configService.get<string>('DEEPSEEK_REASONING_EFFORT') || 'none';
  }

  /**
   * Старшая модель для аудита и живых проверок промптов (LLM-as-judge).
   * Не используется в рантайме бота — только в оффлайн-прогонах промптов.
   */
  get deepseekJudgeModel(): string {
    return this.configService.get<string>('DEEPSEEK_JUDGE_MODEL') || 'deepseek-v4-pro';
  }

  /**
   * Опциональные переопределения тарифа DeepSeek, $ за 1M токенов.
   * Нужны, чтобы обновить расценки без правки кода. Если заданы не все три —
   * используется таблица из constants/deepseek-pricing.ts.
   */
  get deepseekPriceCacheHit(): number | undefined {
    return this.getOptionalNumber('DEEPSEEK_PRICE_CACHE_HIT');
  }

  get deepseekPriceCacheMiss(): number | undefined {
    return this.getOptionalNumber('DEEPSEEK_PRICE_CACHE_MISS');
  }

  get deepseekPriceOutput(): number | undefined {
    return this.getOptionalNumber('DEEPSEEK_PRICE_OUTPUT');
  }

  /** Вероятность язвительного подкола в ответ на обычное сообщение (0..1). */
  get trollSarcasmChance(): number {
    return this.getNumber('TROLL_SARCASM_CHANCE', 0.05);
  }

  /** Минимальная пауза между случайными подколами в одном чате, сек. */
  get trollSarcasmCooldown(): number {
    return this.getNumber('TROLL_SARCASM_COOLDOWN', 300);
  }

  /** Вероятность кривляния (переделывания слова) в ответ на сообщение (0..1). */
  get trollMirrorChance(): number {
    return this.getNumber('TROLL_MIRROR_CHANCE', 0.05);
  }

  /** Минимальная пауза между кривляниями в одном чате, сек. */
  get trollMirrorCooldown(): number {
    return this.getNumber('TROLL_MIRROR_COOLDOWN', 300);
  }

  /** Вероятность реакции-эмодзи (🤡/💩) на сообщение (0..1). */
  get trollReactionChance(): number {
    return this.getNumber('TROLL_REACTION_CHANCE', 0.05);
  }

  /** Минимальная пауза между реакциями в одном чате, сек. */
  get trollReactionCooldown(): number {
    return this.getNumber('TROLL_REACTION_COOLDOWN', 60);
  }

  /** Вероятность сообщения в чат при публикации мема в канал (0..1). */
  get trollMemeAnnounceChance(): number {
    return this.getNumber('TROLL_MEME_ANNOUNCE_CHANCE', 0.1);
  }

  /** Порог вероятности, при котором бот описывает статью УК РФ (0..1). */
  get trollCriminalThreshold(): number {
    return this.getNumber('TROLL_CRIMINAL_THRESHOLD', 0.5);
  }

  /** Порог «почти наверняка» для статьи УК РФ (0..1). */
  get trollCriminalHighThreshold(): number {
    return this.getNumber('TROLL_CRIMINAL_HIGH_THRESHOLD', 0.8);
  }

  /** Минимальная пауза между проверками по УК РФ в одном чате, сек. */
  get trollAnalyzeCooldown(): number {
    return this.getNumber('TROLL_ANALYZE_COOLDOWN', 15);
  }

  /** Окно накопления обращений к боту перед общим ответом, сек (дебаунс). */
  get trollJerkBatchWindow(): number {
    return this.getNumber('TROLL_JERK_BATCH_WINDOW', 15);
  }

  /** Пауза между ответами на клички/мат в одном чате, сек. */
  get trollJerkCooldown(): number {
    return this.getNumber('TROLL_JERK_COOLDOWN', 180);
  }

  /**
   * Пауза без сообщений, после которой беседа считается новой, мин.
   * Нужна, чтобы бот не продолжал нить, которую все уже забыли.
   */
  get trollDialogPauseMin(): number {
    return this.getNumber('TROLL_DIALOG_PAUSE_MIN', 15);
  }

  /** Минимальная пауза между проверками по УК РФ в одном чате, сек. */
  /** Глобальный лимит запросов к DeepSeek в сутки. */
  get trollDailyRequestLimit(): number {
    return this.getNumber('TROLL_DAILY_REQUEST_LIMIT', 2000);
  }

  /** Максимальная длина пользовательского текста для модели. */
  get trollMaxInputChars(): number {
    return this.getNumber('TROLL_MAX_INPUT_CHARS', 1000);
  }

  private getNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /** Число из env, если оно там есть и корректно: иначе undefined (не 0). */
  private getOptionalNumber(key: string): number | undefined {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null || `${raw}`.trim() === '') {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
}
