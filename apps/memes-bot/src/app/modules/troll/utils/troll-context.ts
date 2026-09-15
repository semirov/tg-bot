/**
 * Сборка контекста беседы для модели.
 *
 * Контекст ограничен не «последними N репликами», а временем: бот помнит
 * беседу за сутки (см. TROLL_HISTORY_TTL_HOURS). Но чат живёт рывками: после
 * длинной паузы люди начинают совсем другой разговор, и тянуть старую нить
 * нельзя — бот выглядит как идиот, который отвечает не на то.
 *
 * Поэтому паузы между репликами не выкидываются, а **помечаются**: в
 * расшифровке появляется строка вида «— пауза 2 ч —». Промпт объясняет модели,
 * что до паузы была другая беседа, и продолжать её не надо.
 */

/** Поля реплики, которые нужны для сборки контекста (совместимо с сущностью). */
export interface ConversationMessage {
  role: string;
  content: string;
  userName?: string | null;
  userId?: number | null;
  createdAt: Date;
}

/** Элемент контекста: реплика или отметка о разрыве беседы. */
export type ConversationItem<T extends ConversationMessage> =
  | { kind: 'message'; row: T }
  | { kind: 'pause'; gapMs: number };

export interface ConversationWindowOptions {
  /** Пауза, которая считается разрывом беседы, мс. */
  gapMs: number;
  /** Жёсткий потолок числа реплик в контексте. */
  maxTurns: number;
  /** Жёсткий потолок суммарной длины расшифровки, символов. */
  maxChars: number;
}

/**
 * Собирает контекст беседы в хронологическом порядке (от старой реплики
 * к свежей). На вход ждёт реплики от свежих к старым — так они и достаются
 * из БД (`order: { id: 'DESC' }`).
 *
 * Реплики набираются от свежей назад, пока хватает бюджета символов и реплик.
 * Свежая реплика попадает в контекст всегда — иначе отвечать будет не на что.
 */
export function buildConversationContext<T extends ConversationMessage>(
  rowsNewestFirst: T[],
  options: ConversationWindowOptions
): ConversationItem<T>[] {
  const { gapMs, maxTurns, maxChars } = options;
  const selected: ConversationItem<T>[] = [];
  let usedChars = 0;
  let usedTurns = 0;

  for (let index = 0; index < rowsNewestFirst.length; index += 1) {
    const row = rowsNewestFirst[index];

    if (usedTurns >= maxTurns) {
      break;
    }

    const size = estimateSize(row);
    if (usedTurns > 0 && usedChars + size > maxChars) {
      break;
    }

    // Разрыв считаем относительно более свежей реплики: если между ней и этой
    // прошло больше gapMs, значит выше была другая беседа.
    if (index > 0) {
      const newer = rowsNewestFirst[index - 1];
      const gap = newer.createdAt.getTime() - row.createdAt.getTime();
      if (gap > gapMs) {
        selected.push({ kind: 'pause', gapMs: gap });
      }
    }

    selected.push({ kind: 'message', row });
    usedChars += size;
    usedTurns += 1;
  }

  return selected.reverse();
}

/** Грубая оценка «веса» реплики в расшифровке: текст плюс подпись автора. */
function estimateSize(row: ConversationMessage): number {
  const name = row.userName?.length ?? 0;
  return row.content.length + name + 16;
}

/**
 * Человекочитаемая длительность паузы для расшифровки: «45 мин», «3 ч»,
 * «1 ч 20 мин». От неё зависит, поймёт ли модель, что беседа прервалась.
 */
export function formatConversationPause(gapMs: number): string {
  const totalMinutes = Math.max(1, Math.round(gapMs / 60000));
  if (totalMinutes < 60) {
    return `${totalMinutes} мин`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes < 5) {
    return `${hours} ч`;
  }
  return `${hours} ч ${minutes} мин`;
}
