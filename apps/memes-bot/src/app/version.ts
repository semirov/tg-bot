/**
 * Версия приложения.
 *
 * Источник правды — git-тег в GitHub: версия вычисляется автоматически из
 * conventional commits (semantic-release) и попадает в окружение на сборке и
 * деплое (`APP_VERSION`). Без переменной (локальная разработка) — dev-заглушка.
 */
export const APP_VERSION = process.env.APP_VERSION?.trim() || '0.0.0-dev';
