import type { User } from 'grammy/types';
import { BotContext } from '../../bot/interfaces/bot-context.interface';
import {
  TROLL_MAX_CRIMINAL_REASON_CHARS,
  TROLL_MAX_CRIMINAL_TITLE_CHARS,
  TROLL_MIRROR_MAX_CHARS,
} from '../constants/troll-limits';
import { TrollDefectEntity } from '../entities/troll-defect.entity';
import { TrollMessageEntity } from '../entities/troll-message.entity';
import { CriminalAssessment, TrollRuntimeSettings } from '../interfaces/troll.interface';
import {
  sanitizeModelField,
  sanitizeModelText,
  sanitizeUserInput,
  stripLinks,
} from '../utils/troll-sanitizer';
import { cleanName } from './troll-name-registry';

/** Сообщения короче этого не анализируем (мусор, «+», «ок» и т.п.). */
export const MIN_TEXT_LENGTH = 3;

/**
 * Диагностика дефекта в виде, который печатается владельцу.
 */
export interface DefectDiagnosisView {
  severity: string;
  summary: string;
  problems: string[];
  fixes: string[];
}

/**
 * Чистые форматтеры тролля.
 *
 * Все методы детерминированы, не обращаются к сети/БД и не хранят состояние:
 * собирают тексты (шаблоны сообщений, метки связей, префиксы логов, обрезки) из
 * переданных аргументов. Логика вынесена из god-class `TrollService`, который
 * оставляет у себя тонкие делегирующие обёртки.
 */
export class TrollReplyFormatter {
  /**
   * Ответ статьёй УК: шапка с вероятностью, до трёх статей и общий вывод.
   *
   * @param assessment оценка модели
   * @param probability нормализованная вероятность `0..1`
   * @param s рантайм-настройки (важен `criminalHighThreshold`)
   * @returns HTML-текст ответа
   */
  public buildCriminalReply(
    assessment: CriminalAssessment,
    probability: number,
    s: TrollRuntimeSettings
  ): string {
    const percent = Math.round(probability * 100);
    const articles = Array.isArray(assessment.articles)
      ? assessment.articles.filter((article) => article && article.code)
      : [];

    const head =
      probability >= s.criminalHighThreshold
        ? `⚖️ <b>Почти наверняка состав преступления</b> — ${percent}%`
        : `⚖️ <b>Похоже на статью</b> — ${percent}%`;

    const lines = [head];

    let hasArticleReason = false;
    if (articles.length) {
      lines.push('', 'Возможные статьи:');
      for (const article of articles.slice(0, 3)) {
        const code = sanitizeModelField(article.code, TROLL_MAX_CRIMINAL_TITLE_CHARS);
        const title = sanitizeModelField(article.title, TROLL_MAX_CRIMINAL_TITLE_CHARS);
        const why = sanitizeModelField(article.reason, TROLL_MAX_CRIMINAL_REASON_CHARS);
        if (!code) {
          continue;
        }
        if (why) {
          hasArticleReason = true;
        }
        lines.push(
          `• <b>${this.escapeHtml(code)}</b>${title ? ` — ${this.escapeHtml(title)}` : ''}${
            why ? `: ${this.escapeHtml(why)}` : ''
          }`
        );
      }
    }

    // Общий вывод показываем только если у статей нет пояснения «за что».
    const reason = sanitizeModelField(assessment.reason, TROLL_MAX_CRIMINAL_REASON_CHARS);
    if (reason && !hasArticleReason) {
      lines.push('', `Почему: ${this.escapeHtml(reason)}`);
    }

    return lines.join('\n');
  }

  /**
   * Отчёт владельцу о найденном дефекте: что ответил бот, кому и что говорит
   * диагностика.
   *
   * @param defect сохранённый дефект
   * @param answer ответ бота из истории
   * @param replyTo реплика, на которую бот отвечал (может не быть)
   * @param diagnosis результат разбора
   * @returns текстовый отчёт
   */
  public formatDefectReport(
    defect: TrollDefectEntity,
    answer: TrollMessageEntity,
    replyTo: TrollMessageEntity | null,
    diagnosis: DefectDiagnosisView
  ): string {
    const lines = [
      `Дефект #${defect.id}, серьёзность ${diagnosis.severity}`,
      `чат: ${defect.sourceChatTitle ?? 'без названия'} (${defect.sourceChatId ?? '?'})`,
      replyTo
        ? `бот отвечал: ${cleanName(replyTo.userName) ?? 'участник'} (${
            replyTo.userId ?? '?'
          }), реплика: «${this.cut(replyTo.content, 300)}»`
        : 'бот отвечал не реплаем',
      `ответ бота: «${this.cut(answer.content, 300)}»`,
    ];

    if (diagnosis.summary) {
      lines.push(`диагностика: ${diagnosis.summary}`);
    }
    if (diagnosis.problems.length) {
      lines.push('что не так:', ...diagnosis.problems.map((problem) => `• ${problem}`));
    }
    if (diagnosis.fixes.length) {
      lines.push('как надо было:', ...diagnosis.fixes.map((fix) => `• ${fix}`));
    }
    lines.push(`контекст на момент ответа сохранён в troll_defect_entity #${defect.id}`);

    return lines.join('\n');
  }

  /**
   * Пометка типа нетекстового сообщения (сам контент не храним).
   *
   * @param message сообщение Telegram
   * @returns человекочитаемый тип или `null` для текста/неизвестного
   */
  public describeMediaKind(
    message: NonNullable<BotContext['message']>
  ): string | null {
    const m = message as unknown as Record<string, unknown>;
    if (m['photo']) return 'картинка';
    if (m['video']) return 'видео';
    if (m['animation']) return 'гифка';
    if (m['sticker']) return 'стикер';
    if (m['voice']) return 'голосовое';
    if (m['audio']) return 'аудио';
    if (m['video_note']) return 'видеосообщение';
    if (m['document']) return 'файл';
    if (m['location'] || m['venue']) return 'геолокация';
    if (m['contact']) return 'контакт';
    if (m['poll']) return 'опрос';
    if (m['dice']) return 'кубик';
    return null;
  }

  /**
   * `true`, если в сообщении есть ссылка (по сущностям url/text_link).
   *
   * @param message сообщение Telegram
   * @returns признак наличия ссылки
   */
  public messageHasLink(message: NonNullable<BotContext['message']>): boolean {
    const m = message as unknown as {
      entities?: { type?: string }[];
      caption_entities?: { type?: string }[];
    };
    const entities = [...(m.entities ?? []), ...(m.caption_entities ?? [])];
    return entities.some((entity) => entity.type === 'url' || entity.type === 'text_link');
  }

  /**
   * Собирает запись для истории диалога. Текст храним как текст, нетекстовый
   * контент — только пометкой типа, ссылки — без URL. Сам контент не сохраняем.
   *
   * @param text исходный текст сообщения
   * @param mediaKind пометка типа медиа или `null`
   * @param hasLink признак наличия ссылки
   * @param maxInputChars лимит длины пользовательского текста
   * @returns запись для истории или `null`, если сохранять нечего
   */
  public buildHistoryEntry(
    text: string,
    mediaKind: string | null,
    hasLink: boolean,
    maxInputChars: number
  ): string | null {
    const plain = hasLink ? stripLinks(text) : text;
    const cleanedText =
      plain.length >= MIN_TEXT_LENGTH ? sanitizeUserInput(plain, maxInputChars) : '';
    const marks = [mediaKind ? `[${mediaKind}]` : '', hasLink ? '[ссылка]' : ''].filter(
      (mark) => !!mark
    );
    const parts = [...marks, cleanedText].filter((part) => !!part);
    return parts.length ? parts.join(' ') : null;
  }

  /**
   * Отображаемое имя пользователя Telegram.
   *
   * @param from пользователь или `undefined`
   * @returns имя с `@username` либо «Аноним»
   */
  public describeUser(from: User | undefined): string {
    if (!from) {
      return 'Аноним';
    }
    const parts = [from.first_name, from.last_name].filter((value) => !!value);
    const name = parts.join(' ') || 'Аноним';
    return from.username ? `${name} (@${from.username})` : name;
  }

  /**
   * Экранирует спецсимволы HTML для `parse_mode: 'HTML'`.
   *
   * @param value исходный текст
   * @returns экранированный текст
   */
  public escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Текст для лога: одним рядом без переносов (чтобы запись не разваливалась)
   * и с ограничением длины.
   *
   * @param text исходный текст
   * @param limit максимальная длина до обрезки
   * @returns текст в кавычках, при необходимости обрезанный
   */
  public logText(text: string, limit = 1500): string {
    const flat = text.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
    return flat.length > limit ? `«${flat.slice(0, limit)}…»` : `«${flat}»`;
  }

  /**
   * Метка связей сообщения: « [msg 17, replyTo 15]».
   * msg — номер самого сообщения, replyTo — на чей номер отвечают.
   * Если номеров нет (старые записи), метка пустая.
   *
   * @param messageId номер сообщения
   * @param replyToMessageId номер сообщения, на которое отвечают
   * @returns метка связей
   */
  public describeMessageRefs(
    messageId?: number | null,
    replyToMessageId?: number | null
  ): string {
    if (messageId === null || messageId === undefined) {
      return '';
    }
    const reply =
      replyToMessageId !== null && replyToMessageId !== undefined
        ? `, replyTo ${replyToMessageId}`
        : '';
    return ` [msg ${messageId}${reply}]`;
  }

  /**
   * Короткий префикс для логов: chat=... user=... (без текста сообщений).
   *
   * @param chatId идентификатор чата
   * @param userId идентификатор пользователя
   * @returns префикс для лога
   */
  public tag(chatId: number | undefined, userId?: number): string {
    const parts = [`chat=${chatId ?? '-'}`];
    if (userId !== undefined) {
      parts.push(`user=${userId}`);
    }
    return parts.join(' ');
  }

  /**
   * Вероятность в процентах для логов.
   *
   * @param value вероятность `0..1`
   * @returns строка с процентом
   */
  public pct(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  /**
   * Обрезка длинного текста для сообщения в чат.
   *
   * @param text исходный текст
   * @param limit максимальная длина
   * @returns текст в одну строку, при необходимости с многоточием
   */
  public cut(text: string, limit: number): string {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
  }

  /**
   * Текст ошибки без стектрейса.
   *
   * @param error ошибка любого вида
   * @returns сообщение ошибки
   */
  public describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Текст сообщения или подписи к нему.
   *
   * @param ctx контекст бота
   * @returns обрезанный текст или пустая строка
   */
  public messageText(ctx: BotContext): string {
    const message = ctx.message;
    if (!message) {
      return '';
    }
    return (message.text ?? message.caption ?? '').trim();
  }

  /**
   * Приводит ответ модели к одному слову (буквы и дефис).
   *
   * @param raw сырой ответ модели
   * @returns одно слово, только буквы и дефис
   */
  public normalizeMirrorWord(raw: string): string {
    const first = sanitizeModelText(raw, TROLL_MIRROR_MAX_CHARS).split(/\s+/)[0];
    return first.replace(/[^а-яёА-ЯЁ-]/g, '').slice(0, TROLL_MIRROR_MAX_CHARS);
  }
}
