/**
 * Помощники для разбора дефектов.
 *
 * Владелец присылает боту ответ, который считает неудачным, и бот ищет этот
 * ответ в истории переписки. Форвард из группы приходит **без id** исходного
 * сообщения: Telegram отдаёт для него только автора и дату, поэтому исходный
 * ответ ищем по тексту и времени — сначала точное совпадение, потом
 * нормализованное (переносы, кавычки, концевая пунктуация), из подходящих
 * берём ближайший по времени отправки.
 *
 * Логика вынесена в чистые функции, чтобы её можно было покрыть тестами
 * без Telegram и базы.
 */

export interface DefectCandidate {
  id: number;
  chatId: number;
  content: string;
  /** Когда реплика попала в базу — примерно равно времени отправки. */
  createdAt: Date;
}

export interface DefectSearch {
  /** Текст присланного ответа (то, что владелец форварднул). */
  text: string;
  /** Время исходного сообщения из `forward_origin`, если Telegram его отдал. */
  sentAt?: Date;
  /** Допустимое расхождение по времени в мс (0 — не проверять время). */
  windowMs?: number;
}

/** Невидимые символы, которыми Telegram иногда обвешивает текст. */
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;
/** Пунктуация по краям: её могут срезать при копировании и форварде. */
const EDGE_PUNCTUATION = /^[\s«»"'().,!?…:;—–-]+|[\s«»"'().,!?…:;—–-]+$/g;

/** Текст для сравнения: без невидимых символов, переносов и лишних пробелов. */
export function normalizeMatchText(text: string): string {
  return (text ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Тот же текст без пунктуации по краям. */
function withoutEdgePunctuation(text: string): string {
  return text.replace(EDGE_PUNCTUATION, '');
}

/** Похож ли присланный текст на этот ответ бота. */
export function isSameAnswer(answer: string, sent: string): boolean {
  const left = normalizeMatchText(answer);
  const right = normalizeMatchText(sent);
  if (!left || !right) {
    return false;
  }
  return left === right || withoutEdgePunctuation(left) === withoutEdgePunctuation(right);
}

export interface DefectMatch {
  candidate: DefectCandidate;
  /** true — текст совпал символ в символ, false — после нормализации. */
  exact: boolean;
}

/**
 * Выбирает из кандидатов тот ответ, который прислал владелец.
 * Точное совпадение важнее нормализованного, при равном совпадении берётся
 * ближайший по времени к исходному сообщению.
 */
export function pickDefectAnswer(
  candidates: DefectCandidate[],
  search: DefectSearch
): DefectMatch | null {
  const text = normalizeMatchText(search.text);
  if (!text) {
    return null;
  }

  const windowMs = search.windowMs ?? 0;
  const scored = candidates
    .map((candidate) => {
      const normalized = normalizeMatchText(candidate.content);
      const delta = search.sentAt
        ? Math.abs(candidate.createdAt.getTime() - search.sentAt.getTime())
        : 0;
      return {
        candidate,
        exact: normalized === text,
        matches: normalized === text || withoutEdgePunctuation(normalized) === withoutEdgePunctuation(text),
        delta,
      };
    })
    .filter((item) => item.matches)
    // Если время отправки известно, чужие совпадения по тексту не берём.
    .filter((item) => windowMs <= 0 || !search.sentAt || item.delta <= windowMs);

  if (!scored.length) {
    return null;
  }

  scored.sort((left, right) => {
    if (left.exact !== right.exact) {
      return left.exact ? -1 : 1;
    }
    return left.delta - right.delta;
  });

  return { candidate: scored[0].candidate, exact: scored[0].exact };
}
