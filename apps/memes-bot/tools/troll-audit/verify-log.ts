/**
 * Аудит живых ответов бота по логам: берёт реальные (контекст, ответ) из логов
 * и проверяет каждый ответ старшей моделью (deepseek-v4-pro).
 *
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only -O '{"module":"commonjs"}' troll-audit/verify-log.ts /tmp/live.log
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { JUDGE_MODEL, call, parseJson, pool, withTag } from './llm';
import { attachTrace, hr, say, show } from './log';

interface LiveCase {
  lineNo: number;
  time: string;
  transcript: string;
  answer: string;
  sent: string;
}

export interface Verdict {
  id: number;
  time: string;
  sent: string;
  addresseeMismatch: boolean;
  score: number;
  issues: string[];
  verdict: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const HEAD =
  /\[Nest\]\s+\d+\s+-\s+(\d{2}\/\d{2}\/\d{4},\s+\d+:\d+:\d+\s+[AP]M)\s+\w+\s+\[[^\]]+\]\s*(.*)$/;

const RUBRIC = `Ты — придирчивый аудитор реальных ответов тролль-бота в Telegram-чате. Тебе дают ту самую расшифровку, которую видел бот, и его ответ.
Формат расшифровки: «Имя (userId) [msg 17, replyTo 15]: текст» — authorId в скобках, msg — номер сообщения, replyTo — на чей номер отвечают; строка «бот [msg N]» — прошлые сообщения самого бота.
В конце расшифровки есть задание: кому бот отвечает.

Проверь по пунктам:
1) АДРЕСАТ: отвечает ли бот тому, кто к нему обратился, и не приписывает ли ему слова ДРУГОГО участника (по replyTo и по тому, кто именно это писал). Это самый важный пункт.
2) ПОПАДАНИЕ: ответ по смыслу последней реплики, а не мимо темы.
3) СВЯЗНОСТЬ: одна понятная мысль, нет каши из склеенных идей и уходов в постороннюю метафору.
4) РОЛЬ: дерзко и живо, но без кода, без объяснений «как справочная», без рассуждений о себе как о программе и без выдуманных фактов о людях.
5) ПОВТОРЫ: не копирует ли уже звучавшие у бота реплики-шаблоны дословно.

Верни строго JSON:
{"score": 0.0, "addressee_mismatch": false, "verdict": "одна фраза", "issues": ["конкретные проблемы, с цитатами"]}
score — общее качество от 0 до 1 (1 = отлично). addressee_mismatch = true, если бот перепутал адресата или приписал ему чужие слова.`;

function parseLog(path: string): LiveCase[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const cases: LiveCase[] = [];
  let lastTime = '';
  let lastTranscript: string | null = null;
  let lastAnswer: string | null = null;

  lines.forEach((raw, index) => {
    const line = raw.replace(ANSI, '');
    const head = line.match(HEAD);
    if (!head) {
      return;
    }
    const [, time, message] = head;
    lastTime = time;

    if (message.startsWith('LLM-данные')) {
      lastTranscript = message.replace(/^LLM-данные \([^)]*\):\s*/, '').replace(/ ⏎ /g, '\n');
      lastAnswer = null;
      return;
    }

    if (message.startsWith('LLM-ответ')) {
      lastAnswer = message.replace(/^LLM-ответ:\s*/, '').replace(/ ⏎ /g, '\n');
      return;
    }

    const sent = message.match(/^chat=(-?\d+):\s+отправлено(?:\s+\(без ответа\))?(\s+\[msg[^\]]*\])?\s+(«[\s\S]*»)$/);
    if (!sent || !lastTranscript || !lastAnswer) {
      return;
    }

    cases.push({
      lineNo: index + 1,
      time,
      transcript: lastTranscript,
      answer: lastAnswer,
      sent: sent[sent.length - 1],
    });
    lastTranscript = null;
    lastAnswer = null;
  });

  return cases;
}

function isDialogCall(item: LiveCase): boolean {
  // Диалоговые вызовы отличаются расшифровкой с номерами сообщений.
  if (!/\[msg \d+/.test(item.transcript)) {
    return false;
  }
  // Пропускаем JSON-ответы (анализ по УК РФ) и пустые.
  if (item.answer.trim().startsWith('{')) {
    return false;
  }
  return item.sent.length > 3;
}

async function judgeOne(item: LiveCase, id: number): Promise<Verdict> {
  const transcript = item.transcript.length > 12000 ? `…(начало опущено)…\n${item.transcript.slice(-12000)}` : item.transcript;

  const raw = await call(
    [
      { role: 'system', content: RUBRIC },
      {
        role: 'user',
        content: [
          'РАСШИФРОВКА, КОТОРУЮ ВИДЕЛ БОТ:',
          '<transcript>',
          transcript,
          '</transcript>',
          '',
          'ОТВЕТ БОТА:',
          '<answer>',
          item.answer,
          '</answer>',
          '',
          'Верни JSON по схеме.',
        ].join('\n'),
      },
    ],
    { model: JUDGE_MODEL, temperature: 0, maxTokens: 3000, json: true, reasoningEffort: 'low', kind: 'assess', label: 'судья pro' }
  );

  const parsed = parseJson<{
    score?: number;
    addressee_mismatch?: boolean;
    verdict?: string;
    issues?: string[];
  }>(raw);

  return {
    id,
    time: item.time,
    sent: item.sent,
    addresseeMismatch: parsed?.addressee_mismatch === true,
    score: typeof parsed?.score === 'number' ? parsed.score : 0,
    verdict: parsed?.verdict ?? '(судья не ответил)',
    issues: Array.isArray(parsed?.issues) ? parsed!.issues.filter((i) => typeof i === 'string') : [],
  };
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? '/tmp/live.log';
  const all = parseLog(path);
  const dialog = all.filter(isDialogCall);
  const concurrency = Math.max(1, Number(process.env.AUDIT_CONCURRENCY ?? 3));

  attachTrace();

  process.stdout.write(
    `Из лога извлечено ответов: ${all.length}, диалоговых (с расшифровкой): ${dialog.length}` +
      `, проверяю параллельно ${concurrency}\n` +
      `Проверяю старшей моделью ${JUDGE_MODEL}` +
      ' (AUDIT_CONCURRENCY=1 — строго по порядку, AUDIT_QUIET=1 — без живых логов)\n\n'
  );

  const verdicts = await pool(dialog, concurrency, (item, index) =>
    withTag(item.time, async () => {
      const verdict = await judgeOne(item, index);
      hr(`кейс ${verdict.time}`);
      show(verdict.time, 'бот', verdict.sent, 400);
      say(
        verdict.time,
        `резолюция судьи pro: ${verdict.score.toFixed(2)}${
          verdict.addresseeMismatch ? ' [ПУТАНИЦА АДРЕСАТА]' : ''
        } — ${verdict.verdict}`
      );
      for (const issue of verdict.issues) {
        say(verdict.time, `  судья: ${issue}`);
      }
      return verdict;
    })
  );

  verdicts.sort((a, b) => a.score - b.score);

  const mismatches = verdicts.filter((v) => v.addresseeMismatch);
  const weak = verdicts.filter((v) => v.score < 0.6);
  const avg = verdicts.reduce((sum, v) => sum + v.score, 0) / (verdicts.length || 1);

  process.stdout.write(`\n${'='.repeat(78)}\nИтог: ответов ${verdicts.length}, средний балл ${avg.toFixed(2)}\n`);
  process.stdout.write(`Путаница адресата: ${mismatches.length}\nСлабых ответов (score < 0.6): ${weak.length}\n`);

  process.stdout.write(`\n${'='.repeat(78)}\nХудшие ответы:\n`);
  for (const verdict of verdicts.slice(0, 12)) {
    process.stdout.write(`\n--- ${verdict.time} (score ${verdict.score.toFixed(2)})${verdict.addresseeMismatch ? ' [ПУТАНИЦА АДРЕСАТА]' : ''}\n`);
    process.stdout.write(`ответ: ${verdict.sent.replace(/\n/g, ' ⏎ ').slice(0, 400)}\n`);
    process.stdout.write(`вывод: ${verdict.verdict}\n`);
    for (const issue of verdict.issues) {
      process.stdout.write(`  • ${issue}\n`);
    }
  }

  writeFileSync('/tmp/verify-log.json', JSON.stringify(verdicts, null, 2), 'utf8');
  process.stdout.write(`\nОтчёт: /tmp/verify-log.json\n`);
}

void main();
