/**
 * Утилиты очистки ввода/вывода тролль-бота.
 *
 * Защищают от типовых LLM-векторов:
 *  - prompt injection: контент пользователя оборачивается в делимитеры, а сами
 *    делимитеры вырезаются из ввода, чтобы нельзя было «закрыть» обёртку;
 *  - перерасход токенов: жёсткое усечение ввода и вывода;
 *  - unicode-трюки: NFKC-нормализация и вычистка zero-width / bidi / control;
 *  - инъекция разметки и фишинга: вырезаем HTML, markdown-ссылки, URL и @упоминания.
 */

import { TROLL_HARD_MAX_INPUT_CHARS } from '../constants/troll-limits';

const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
// eslint-disable-next-line no-control-regex -- намеренно вычищаем управляющие символы
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const HTML_TAG_REGEX = /<[^>]*>/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\((?:https?:\/\/|tg:\/\/|mailto:)[^)\s]*\)/gi;
const BARE_URL_REGEX = /(?:https?:\/\/|www\.|t\.me\/)\S+/gi;
const MENTION_REGEX = /@[a-zA-Z0-9_]{3,}/g;
/** Выделение markdown (жирный, курсив, код): в чате это просто мусорные символы. */
const MARKDOWN_EMPHASIS_REGEX = /\*\*|__|`{1,3}/g;
/** Заголовки markdown в начале строки. */
const MARKDOWN_HEADING_REGEX = /^#{1,6}\s+/gm;

const USER_MESSAGE_OPEN = '<user_message>';
const USER_MESSAGE_CLOSE = '</user_message>';
const DELIMITER_REGEX = /<\/?user_message>/gi;

/** Короткие сокращения, у которых точку не трогаем. */
const ABBREVIATIONS = new Set([
  'ст', 'т', 'тт', 'ч', 'г', 'гг', 'ул', 'д', 'н', 'им', 'руб', 'коп',
  'млн', 'млрд', 'тыс', 'др', 'напр', 'см', 'рис', 'стр', 'п', 'чел',
]);

/**
 * Убирает точки в конце предложений (после слова перед пробелом/концом строки),
 * не трогая сокращения вроде «ст. 228» и числа вроде «228.1».
 * Нужна для коротких полей (название статьи, пояснение), где текст идёт в одну строку.
 */
function stripSentencePeriods(input: string): string {
  return input.replace(
    /([0-9a-zа-яё]+)(["»”')\]]*)\.+(?=\s|$)/gi,
    (match, word: string, closers: string) =>
      ABBREVIATIONS.has(word.toLowerCase()) ? match : `${word}${closers}`
  );
}

/**
 * Разбивает текст по границам предложений на строки: в тг-чате фразы пишут
 * с новой строки, а точки не ставят. Без этого многофразный ответ (саммари)
 * превращался в одну длинную «простыню» после вырезания точек.
 * Сокращения («ст. 228») границей не считаются; завершающие кавычки и скобки
 * переносятся вместе со словом.
 */
function splitSentencesToLines(input: string): string {
  return input.replace(
    /([0-9a-zа-яё]+)(["»”')\]]*)\.+(\s+)/gi,
    (match, word: string, closers: string) =>
      ABBREVIATIONS.has(word.toLowerCase()) ? match : `${word}${closers}\n`
  );
}

/** Убирает точки в конце строк — чатовый стиль, точки не ставим. */
function stripLinePeriods(input: string): string {
  return input
    .split('\n')
    .map((line) => {
      const stripped = line.replace(/\.+$/, '');
      if (stripped === line) {
        return line;
      }
      // «ст.» в конце строки — сокращение, точку оставляем.
      const lastWord = stripped.match(/([0-9a-zа-яё]+)["»”')\]]*$/i)?.[1];
      return lastWord && ABBREVIATIONS.has(lastWord.toLowerCase()) ? line : stripped;
    })
    .join('\n');
}

/** Вырезает служебные и невидимые символы, нормализует юникод. */
function stripInvisible(input: string): string {
  return input
    .normalize('NFKC')
    .replace(ZERO_WIDTH_AND_BIDI, '')
    .replace(CONTROL_CHARS, '');
}

function collapseWhitespace(input: string): string {
  return input
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Очищает пользовательский текст перед отправкой в модель.
 * Результат безопасно вставлять внутрь <user_message>...</user_message>.
 */
export function sanitizeUserInput(input: string, maxChars: number): string {
  const limit = Math.max(1, Math.min(Math.floor(maxChars), TROLL_HARD_MAX_INPUT_CHARS));
  let text = stripInvisible(input);
  // Нейтрализуем собственные делимитеры — иначе можно «выйти» из обёртки.
  text = text.replace(DELIMITER_REGEX, ' ');
  text = collapseWhitespace(text);
  if (text.length > limit) {
    text = text.slice(0, limit).trim();
  }
  return text;
}

/** Оборачивает пользовательский текст в делимитеры как недоверенные данные. */
export function wrapUserContent(cleaned: string): string {
  return `${USER_MESSAGE_OPEN}\n${cleaned}\n${USER_MESSAGE_CLOSE}`;
}

/** true, если в тексте есть ссылка (http(s)://, www., t.me/). */
export function containsLink(text: string): boolean {
  return new RegExp(BARE_URL_REGEX.source, 'i').test(text);
}

/**
 * Убирает ссылки (и лишние пробелы). Нужно для хранения истории:
 * содержание ссылок не храним, только сопровождающий текст.
 */
export function stripLinks(text: string): string {
  return collapseWhitespace(text.replace(new RegExp(BARE_URL_REGEX.source, 'gi'), ' '));
}

/**
 * Общая очистка текста модели: разметка, ссылки, упоминания, невидимые
 * символы, длинные тире → дефис, усечение по длине. Регистр и точки не трогает.
 */
function cleanModelText(input: string, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars));
  let text = stripInvisible(input);
  text = text.replace(HTML_TAG_REGEX, ' ');
  text = text.replace(MARKDOWN_LINK_REGEX, '$1');
  text = text.replace(BARE_URL_REGEX, ' ');
  text = text.replace(MENTION_REGEX, ' ');
  text = text.replace(MARKDOWN_HEADING_REGEX, '');
  text = text.replace(MARKDOWN_EMPHASIS_REGEX, '');
  // Длинные тире заменяем обычным дефисом (стиль чата).
  text = text.replace(/[—–―‒]/g, '-');
  text = collapseWhitespace(text);
  text = text.replace(/\s+([,.!?;:])/g, '$1');
  // Убираем строки, состоящие только из знаков препинания (модель иногда шлёт одинокую точку).
  text = text.replace(/^[.,;:!?…\-—]+$/gm, '');
  text = collapseWhitespace(text);
  if (text.length > limit) {
    text = text.slice(0, limit).trim();
  }
  return text;
}

/**
 * Очищает произвольный текст модели перед отправкой в чат.
 * Убирает разметку, ссылки и упоминания; усекает по длине.
 * Предложения разносит по строкам, а точки в концах строк вырезает (чатовый стиль).
 */
export function sanitizeModelText(input: string, maxChars: number): string {
  const text = stripLinePeriods(splitSentencesToLines(cleanModelText(input, maxChars)));
  return collapseWhitespace(text);
}

/**
 * Очищает текст модели, сохраняя исходный регистр и внутренние точки
 * (убирается только точка в самом конце). Используется для «стильных»
 * ответов вроде предсказаний.
 */
export function sanitizeModelStyled(input: string, maxChars: number): string {
  const text = cleanModelText(input, maxChars);
  return text.replace(/\.+$/, '').trimEnd();
}

/**
 * Приводит текст к «чатовому» виду: всё строчными буквами.
 * Используется для неформальных ответов в чате.
 */
export function toChatStyle(input: string): string {
  return input.toLowerCase();
}

/**
 * Очищает короткое текстовое поле из JSON-ответа модели (название статьи,
 * пояснение). Допускает буквы, цифры и обычную пунктуацию, но без разметки,
 * ссылок и упоминаний.
 */
export function sanitizeModelField(input: unknown, maxChars: number): string {
  if (typeof input !== 'string') {
    return '';
  }
  // Поля идут в одну строку — переносы строк здесь недопустимы.
  return collapseWhitespace(stripSentencePeriods(cleanModelText(input, maxChars)));
}
