import configuration from './configuration';

describe('configuration', () => {
  const KEYS = [
    'BOT_TOKEN',
    'BOT_OWNER_ID',
    'MANAGED_CHANNEL',
    'BEST_MANAGED_CHANNEL',
    'USER_REQUEST_CHANNEL',
    'CRINGE_CHANNEL',
    'PARSER_USER_ID',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
    'DATABASE_NAME',
    'APP_API_ID',
    'APP_API_HASH',
    'TG_ENV',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'MATTERMOST_BASE_URL',
    'MATTERMOST_TOKEN',
    'MATTERMOST_CHANNEL_ID',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_MODEL',
    'DEEPSEEK_VISION_MODEL',
    'TROLL_SARCASM_CHANCE',
    'TROLL_SARCASM_COOLDOWN',
    'TROLL_MIRROR_CHANCE',
    'TROLL_MIRROR_COOLDOWN',
    'TROLL_REACTION_CHANCE',
    'TROLL_REACTION_COOLDOWN',
    'TROLL_CRIMINAL_THRESHOLD',
    'TROLL_CRIMINAL_HIGH_THRESHOLD',
    'TROLL_ANALYZE_COOLDOWN',
    'TROLL_JERK_BATCH_WINDOW',
    'TROLL_JERK_COOLDOWN',
    'TROLL_DIALOG_PAUSE_MIN',
    'TROLL_DAILY_REQUEST_LIMIT',
    'TROLL_MAX_INPUT_CHARS',
  ];

  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('содержит все ключи конфигурации', () => {
    const config = configuration();
    expect(Object.keys(config).sort()).toEqual([...KEYS].sort());
  });

  it('подставляет дефолты TG_ENV и S3_REGION', () => {
    delete process.env.TG_ENV;
    delete process.env.S3_REGION;

    const config = configuration();

    expect(config.TG_ENV).toBe('prod');
    expect(config.S3_REGION).toBe('ru-central1');
  });

  it('значения из process.env перекрывают дефолты', () => {
    process.env.TG_ENV = 'test';
    process.env.S3_REGION = 'us-east-1';
    process.env.BOT_TOKEN = 'token';

    const config = configuration();

    expect(config.TG_ENV).toBe('test');
    expect(config.S3_REGION).toBe('us-east-1');
    expect(config.BOT_TOKEN).toBe('token');
  });

  it('PARSER_USER_ID и MONITOR_* берутся из переменных окружения', () => {
    process.env.PARSER_USER_ID = '4242';
    const config = configuration();

    expect(config.PARSER_USER_ID).toBe('4242');
  });
});
