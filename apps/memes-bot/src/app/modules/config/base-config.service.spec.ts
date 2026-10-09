import { BaseConfigService } from './base-config.service';

function makeConfig(values: Record<string, any>): any {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (key in values) {
        return values[key];
      }
      throw new Error(`Нет переменной ${key}`);
    }),
  };
}

function getter(service: BaseConfigService, prop: string): any {
  return (service as any)[prop];
}

describe('BaseConfigService', () => {
  describe('обязательные строковые переменные', () => {
    const cases: Array<[string, string, string]> = [
      ['botToken', 'BOT_TOKEN', 'token-1'],
      ['databaseHost', 'DATABASE_HOST', 'db.internal'],
      ['databaseUsername', 'DATABASE_USERNAME', 'app'],
      ['databasePassword', 'DATABASE_PASSWORD', 'secret'],
      ['databaseName', 'DATABASE_NAME', 'memes'],
      ['appApiHash', 'APP_API_HASH', 'api-hash'],
      ['tgEnv', 'TG_ENV', 'test'],
      ['s3Endpoint', 'S3_ENDPOINT', 'https://s3.example'],
      ['s3Region', 'S3_REGION', 'ru-central1'],
      ['s3Bucket', 'S3_BUCKET', 'memes-bucket'],
      ['s3AccessKeyId', 'S3_ACCESS_KEY_ID', 'access'],
      ['s3SecretAccessKey', 'S3_SECRET_ACCESS_KEY', 'secret-key'],
    ];

    it.each(cases)('%s читает %s', (prop, key, value) => {
      const service = new BaseConfigService(makeConfig({ [key]: value }));
      expect(getter(service, prop)).toBe(value);
    });

    it('getOrThrow прокидывает ошибку отсутствующей переменной', () => {
      const service = new BaseConfigService(makeConfig({}));
      expect(() => getter(service, 'botToken')).toThrow('Нет переменной BOT_TOKEN');
    });
  });

  describe('числовые переменные, полученные через getOrThrow', () => {
    const cases: Array<[string, string, number]> = [
      ['ownerId', 'BOT_OWNER_ID', 42],
      ['memeChanelId', 'MANAGED_CHANNEL', -100500],
      ['bestMemeChanelId', 'BEST_MANAGED_CHANNEL', -100501],
      ['userRequestMemeChannel', 'USER_REQUEST_CHANNEL', -100502],
      ['cringeMemeChannelId', 'CRINGE_CHANNEL', -100503],
      ['databasePort', 'DATABASE_PORT', 5432],
      ['appApiId', 'APP_API_ID', 2040],
    ];

    it.each(cases)('%s приводит %s к числу', (prop, key, value) => {
      const service = new BaseConfigService(makeConfig({ [key]: String(value) }));
      expect(getter(service, prop)).toBe(value);
    });
  });

  describe('useSSL', () => {
    it('истинно только для строки "true"', () => {
      expect(getter(new BaseConfigService(makeConfig({ USE_SSL: 'true' })), 'useSSL')).toBe(true);
      expect(getter(new BaseConfigService(makeConfig({ USE_SSL: 'false' })), 'useSSL')).toBe(false);
      expect(getter(new BaseConfigService(makeConfig({ USE_SSL: '1' })), 'useSSL')).toBe(false);
    });
  });

  describe('переменные с дефолтом', () => {
    const cases: Array<[string, string, string]> = [
      ['mattermostBaseUrl', 'MATTERMOST_BASE_URL', 'https://time.tbank.ru'],
      ['mattermostToken', 'MATTERMOST_TOKEN', ''],
      ['mattermostChannelId', 'MATTERMOST_CHANNEL_ID', ''],
      ['mattermostImageBaseUrl', 'MATTERMOST_IMAGE_BASE_URL', ''],
      ['deepseekBaseUrl', 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com'],
      ['deepseekModel', 'DEEPSEEK_MODEL', 'deepseek-flash'],
      ['deepseekVisionModel', 'DEEPSEEK_VISION_MODEL', 'deepseek-flash'],
      ['deepseekReasoningEffort', 'DEEPSEEK_REASONING_EFFORT', 'none'],
      ['deepseekApiKey', 'DEEPSEEK_API_KEY', ''],
    ];

    it.each(cases)('%s берёт значение из env', (prop, key) => {
      const service = new BaseConfigService(makeConfig({ [key]: 'X' }));
      expect(getter(service, prop)).toBe('X');
    });

    it.each(cases)('%s возвращает дефолт без env', (prop, _key, fallback) => {
      const service = new BaseConfigService(makeConfig({}));
      expect(getter(service, prop)).toBe(fallback);
    });

    it('falsy-значение (пустая строка) даёт дефолт для ||, но не для ??', () => {
      const empty = new BaseConfigService(makeConfig({ DEEPSEEK_BASE_URL: '', DEEPSEEK_API_KEY: '' }));
      expect(getter(empty, 'deepseekBaseUrl')).toBe('https://api.deepseek.com');
      expect(getter(empty, 'deepseekApiKey')).toBe('');
    });

    it('null для deepseekApiKey даёт пустую строку (??, не ||)', () => {
      const service = new BaseConfigService(makeConfig({ DEEPSEEK_API_KEY: null }));
      expect(getter(service, 'deepseekApiKey')).toBe('');
    });
  });

  describe('deepseekUseProModel', () => {
    it('по умолчанию включён', () => {
      expect(getter(new BaseConfigService(makeConfig({})), 'deepseekUseProModel')).toBe(true);
    });

    it('выключается строкой "false" (регистр не важен), пустая строка — дефолт', () => {
      expect(
        getter(new BaseConfigService(makeConfig({ DEEPSEEK_USE_PRO_MODEL: 'false' })), 'deepseekUseProModel')
      ).toBe(false);
      expect(
        getter(new BaseConfigService(makeConfig({ DEEPSEEK_USE_PRO_MODEL: 'FALSE' })), 'deepseekUseProModel')
      ).toBe(false);
      expect(
        getter(new BaseConfigService(makeConfig({ DEEPSEEK_USE_PRO_MODEL: 'true' })), 'deepseekUseProModel')
      ).toBe(true);
      expect(
        getter(new BaseConfigService(makeConfig({ DEEPSEEK_USE_PRO_MODEL: '' })), 'deepseekUseProModel')
      ).toBe(true);
      expect(
        getter(new BaseConfigService(makeConfig({ DEEPSEEK_USE_PRO_MODEL: null })), 'deepseekUseProModel')
      ).toBe(true);
    });
  });

  describe('parserEnabled', () => {
    it('по умолчанию включён', () => {
      expect(getter(new BaseConfigService(makeConfig({})), 'parserEnabled')).toBe(true);
    });

    it('выключается только строкой "false" (регистр не важен), пустая строка — дефолт', () => {
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_ENABLED: 'false' })), 'parserEnabled')
      ).toBe(false);
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_ENABLED: 'FALSE' })), 'parserEnabled')
      ).toBe(false);
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_ENABLED: 'true' })), 'parserEnabled')
      ).toBe(true);
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_ENABLED: '' })), 'parserEnabled')
      ).toBe(true);
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_ENABLED: null })), 'parserEnabled')
      ).toBe(true);
    });
  });

  describe('числовые переменные с дефолтом (getNumber)', () => {
    it('deepseekDailyRequestLimit парсит значение', () => {
      const service = new BaseConfigService(makeConfig({ DEEPSEEK_DAILY_REQUEST_LIMIT: '7.5' }));
      expect(getter(service, 'deepseekDailyRequestLimit')).toBe(7.5);
    });

    it('deepseekDailyRequestLimit отдаёт дефолт, когда env нет', () => {
      const service = new BaseConfigService(makeConfig({}));
      expect(getter(service, 'deepseekDailyRequestLimit')).toBe(2000);
    });

    it('нечисловое значение откатывается к дефолту', () => {
      const service = new BaseConfigService(
        makeConfig({ DEEPSEEK_DAILY_REQUEST_LIMIT: 'Infinity' })
      );
      expect(getter(service, 'deepseekDailyRequestLimit')).toBe(2000);
    });

    it('пустая строка — это отсутствие значения, а не 0', () => {
      const service = new BaseConfigService(makeConfig({ DEEPSEEK_DAILY_REQUEST_LIMIT: '' }));
      expect(getter(service, 'deepseekDailyRequestLimit')).toBe(2000);
    });
  });

  describe('опциональные числовые переменные (getOptionalNumber)', () => {
    it('возвращает число, если оно задано и корректно', () => {
      const service = new BaseConfigService(
        makeConfig({
          DEEPSEEK_PRICE_CACHE_HIT: '1.25',
          DEEPSEEK_PRICE_CACHE_MISS: '2',
          DEEPSEEK_PRICE_OUTPUT: '3.5',
        })
      );
      expect(getter(service, 'deepseekPriceCacheHit')).toBe(1.25);
      expect(getter(service, 'deepseekPriceCacheMiss')).toBe(2);
      expect(getter(service, 'deepseekPriceOutput')).toBe(3.5);
    });

    it('отсутствующее значение — undefined', () => {
      const service = new BaseConfigService(makeConfig({}));
      expect(getter(service, 'deepseekPriceCacheHit')).toBeUndefined();
      expect(getter(service, 'deepseekPriceCacheMiss')).toBeUndefined();
      expect(getter(service, 'deepseekPriceOutput')).toBeUndefined();
    });

    it('null и пустые строки — undefined', () => {
      const service = new BaseConfigService(
        makeConfig({
          DEEPSEEK_PRICE_CACHE_HIT: null,
          DEEPSEEK_PRICE_CACHE_MISS: '',
          DEEPSEEK_PRICE_OUTPUT: '   ',
        })
      );
      expect(getter(service, 'deepseekPriceCacheHit')).toBeUndefined();
      expect(getter(service, 'deepseekPriceCacheMiss')).toBeUndefined();
      expect(getter(service, 'deepseekPriceOutput')).toBeUndefined();
    });

    it('отрицательное и нечисловое значение — undefined', () => {
      const service = new BaseConfigService(
        makeConfig({ DEEPSEEK_PRICE_CACHE_HIT: '-1', DEEPSEEK_PRICE_CACHE_MISS: 'abc' })
      );
      expect(getter(service, 'deepseekPriceCacheHit')).toBeUndefined();
      expect(getter(service, 'deepseekPriceCacheMiss')).toBeUndefined();
    });
  });

  describe('parserUserId', () => {
    it('возвращает число, если PARSER_USER_ID задан', () => {
      const service = new BaseConfigService(makeConfig({ PARSER_USER_ID: '4242' }));
      expect(getter(service, 'parserUserId')).toBe(4242);
    });

    it('undefined без env, для пустой строки, null и мусора', () => {
      expect(getter(new BaseConfigService(makeConfig({})), 'parserUserId')).toBeUndefined();
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_USER_ID: '' })), 'parserUserId')
      ).toBeUndefined();
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_USER_ID: null })), 'parserUserId')
      ).toBeUndefined();
      expect(
        getter(new BaseConfigService(makeConfig({ PARSER_USER_ID: 'abc' })), 'parserUserId')
      ).toBeUndefined();
    });
  });
});
