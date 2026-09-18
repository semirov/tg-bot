import type { Config } from '@jest/types';

/**
 * Конфиг e2e-тестов: поднимают реальное Nest-приложение и реальный grammY Bot,
 * но без сети (фейковый Telegram API) и на одноразовой Postgres.
 */
export default {
  displayName: 'memes-bot-e2e',
  preset: '../../jest.preset.js',
  rootDir: '.',
  testEnvironment: 'node',
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.spec.json',
    },
  },
  transform: {
    '^.+\\.[tj]s$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/e2e/setup-e2e.ts'],
  testTimeout: 60000,
} as Config.ProjectConfig;
