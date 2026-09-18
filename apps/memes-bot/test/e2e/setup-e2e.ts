/**
 * Настройка окружения для e2e-тестов.
 *
 * В CI/докере переменные приходят из docker-compose.test.yml; локально и на
 * всякий случай подставляем тестовые значения-заглушки, чтобы приложение могло
 * стартовать без реальных секретов.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  TG_ENV: 'test',
  APP_VERSION: '0.0.0-test',
  BOT_TOKEN: '111111:TEST_TOKEN',
  MONITOR_BOT_TOKEN: '222222:TEST_MONITOR_TOKEN',
  BOT_OWNER_ID: '424242',
  APP_API_ID: '123456',
  APP_API_HASH: 'test-api-hash',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5433',
  DATABASE_USERNAME: 'postgres',
  DATABASE_PASSWORD: 'postgres',
  DATABASE_NAME: 'memes_e2e',
  USE_SSL: 'false',
  MANAGED_CHANNEL: '-1001111111111',
  BEST_MANAGED_CHANNEL: '-1002222222222',
  USER_REQUEST_CHANNEL: '-1003333333333',
  CRINGE_CHANNEL: '-1004444444444',
  OBSERVER_CHANNEL: '-1005555555555',
  S3_ENDPOINT: 'https://storage.example.test',
  S3_REGION: 'ru-central1',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
  MATTERMOST_BASE_URL: 'https://mattermost.example.test',
  MATTERMOST_TOKEN: 'test',
  MATTERMOST_CHANNEL_ID: 'test',
  DEEPSEEK_API_KEY: 'test',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.test',
  DEEPSEEK_MODEL: 'deepseek-flash',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

jest.setTimeout(60000);
