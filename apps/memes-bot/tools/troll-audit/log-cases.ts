/**
 * Разбор логов тролль-бота: достаёт реальные пары (расшифровка, ответ),
 * которые уходили в модель, чтобы прогонять их в аудитах.
 */

import { readFileSync } from 'node:fs';
import { parseJson } from './llm';

export interface LiveCase {
  time: string;
  /** Тот самый текст, который бот отправил модели (расшифровка + задание). */
  payload: string;
  /** Сырой ответ модели. */
  answer: string;
  /** Что в итоге ушло в чат (после санитайза и нижнего регистра). */
  sent: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const HEAD =
  /\[Nest\]\s+\d+\s+-\s+(\d{2}\/\d{2}\/\d{4},\s+\d+:\d+:\d+\s+[AP]M)\s+\w+\s+\[[^\]]+\]\s*(.*)$/;

/** Достаёт диалоговые вызовы модели: только те, где есть расшифровка с номерами. */
export function parseLog(path: string): LiveCase[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const cases: LiveCase[] = [];
  let payload: string | null = null;
  let answer: string | null = null;

  lines.forEach((raw) => {
    const line = raw.replace(ANSI, '');
    const head = line.match(HEAD);
    if (!head) {
      return;
    }
    const [, time, message] = head;

    if (message.startsWith('LLM-данные')) {
      payload = message.replace(/^LLM-данные \([^)]*\):\s*/, '');
      answer = null;
      return;
    }

    if (message.startsWith('LLM-ответ')) {
      answer = message.replace(/^LLM-ответ:\s*/, '');
      return;
    }

    const sent = message.match(/^chat=(-?\d+):\s+отправлено(?:\s+\(без ответа\))?(\s+\[msg[^\]]*\])?\s+«([\s\S]*)»$/);
    if (!sent || !payload || !answer) {
      return;
    }

    // Только диалоговые вызовы: у них в задании есть расшифровка с номерами,
    // а у анализа по УК РФ и прочих команд — нет.
    if (!/\[msg \d+/.test(payload) || answer.trim().startsWith('{')) {
      payload = null;
      answer = null;
      return;
    }

    cases.push({ time, payload, answer, sent: sent[3] });
    payload = null;
    answer = null;
  });

  return cases;
}

/** Рубрика для проверки живых ответов старшей моделью. */
export const LIVE_RUBRIC = `Ты — придирчивый аудитор реальных ответов тролль-бота в Telegram-чате. Тебе дают задание, которое ушло модели (расшифровка чата и инструкция), и ответ бота.
Формат расшифровки: «Имя (userId) [msg 17, replyTo 15]: текст»: в скобках id автора, msg — номер сообщения, replyTo — на чей номер отвечают; «бот [msg N]» — прошлые сообщения бота.

Проверь по пунктам:
1) АДРЕСАТ: отвечает ли бот тому, кто обратился, и не приписывает ли ему слова ДРУГОГО участника. Это самый важный пункт.
2) ПОПАДАНИЕ: ответ по смыслу последней реплики, а не мимо темы.
3) СВЯЗНОСТЬ: одна понятная мысль, нет каши из склеенных идей и уходов в постороннюю тему.
4) РОЛЬ: дерзко и живо, с матом; без кода, без объяснений «как справочная», без выдуманных фактов о людях.
5) ПОВТОРЫ: не копирует ли уже звучавшие у бота шаблоны дословно.

Верни строго JSON:
{"score": 0.0, "addressee_mismatch": false, "verdict": "одна фраза", "issues": ["конкретные проблемы, с цитатами"]}
score — общее качество от 0 до 1 (1 = отлично). addressee_mismatch = true, если бот перепутал адресата или приписал ему чужие слова.`;

export interface LiveVerdict {
  score: number;
  addresseeMismatch: boolean;
  verdict: string;
  issues: string[];
}

/** Оценка одного живого ответа старшей моделью. */
export async function judgeLive(
  call: (
    messages: Array<{ role: string; content: string }>,
    options: Record<string, unknown>
  ) => Promise<string>,
  model: string,
  payload: string,
  answer: string
): Promise<LiveVerdict> {
  const trimmed = payload.length > 12000 ? `…(начало опущено)…\n${payload.slice(-12000)}` : payload;

  const raw = await call(
    [
      { role: 'system', content: LIVE_RUBRIC },
      {
        role: 'user',
        content: [
          'ЗАДАНИЕ, КОТОРОЕ УШЛО МОДЕЛИ:',
          '<transcript>',
          trimmed.replace(/ ⏎ /g, '\n'),
          '</transcript>',
          '',
          'ОТВЕТ БОТА:',
          '<answer>',
          answer,
          '</answer>',
          '',
          'Верни JSON по схеме.',
        ].join('\n'),
      },
    ],
    { model, temperature: 0, maxTokens: 3000, json: true, reasoningEffort: 'low', kind: 'assess', label: 'судья pro' }
  );

  const parsed = parseJson<{
    score?: number;
    addressee_mismatch?: boolean;
    verdict?: string;
    issues?: string[];
  }>(raw);

  const issues = Array.isArray(parsed?.issues)
    ? (parsed?.issues as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];

  return {
    score: typeof parsed?.score === 'number' ? parsed.score : 0,
    addresseeMismatch: parsed?.addressee_mismatch === true,
    verdict: parsed?.verdict ?? '(судья не ответил)',
    issues,
  };
}
