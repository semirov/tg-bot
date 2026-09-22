/**
 * Эксперимент: учёт свежести переписки в ответах бота.
 *
 * Чем дальше по времени реплика, тем меньше она должна влиять на ответ.
 * Проверяем схемы:
 *  - flat      — текущая: плоская расшифровка без времени;
 *  - labels    — у каждой реплики возраст + инструкция «свежее важнее»;
 *  - decayA    — хвост (hot) дословно, старое сжато до N символов, с метками;
 *  - decayB    — то же, но окно свежести и длина сжатия другие.
 *
 * Контекст берём полный (24 ч) до целевого сообщения, ответ оценивает судья pro:
 * попал ли в свежую тему и не тянет ли старую.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/dialog-recency.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { JERK_PROMPT } from '../../src/app/modules/troll/constants/troll-prompts';
import { sanitizeModelText, wrapUserContent } from '../../src/app/modules/troll/utils/troll-sanitizer';
import { JUDGE_MODEL, call, parseJson } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const OUT_FILE = process.env.DIALOG_RECENCY_OUT || '/tmp/opencode/dialog-recency.json';
const SAMPLES = Number(process.env.DIALOG_RECENCY_SAMPLES || 2);
const CASE_IDS = (process.env.DIALOG_RECENCY_CASES || '21466,21468,21470,21474,21493')
  .split(',')
  .map((v) => Number(v.trim()));

interface Row {
  id: number;
  role: 'user' | 'assistant';
  userId: number | null;
  userName: string | null;
  content: string;
  messageId: number | null;
  replyToMessageId: number | null;
  createdAt: string;
}

const history: Row[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));

interface Scheme {
  name: string;
  /** Свежие реплики (моложе hotMinutes) — дословно. */
  hotMinutes?: number;
  /** Старше — сжать до стольких символов. */
  oldChars?: number;
  /** Добавлять метку возраста. */
  ageLabels: boolean;
  recencyRule: boolean;
}

const SCHEMES: Scheme[] = [
  { name: 'flat (текущая)', ageLabels: false, recencyRule: false },
  { name: 'labels (возраст+правило)', ageLabels: true, recencyRule: true },
  { name: 'decay 30м/60с', hotMinutes: 30, oldChars: 60, ageLabels: true, recencyRule: true },
  { name: 'decay 60м/120с', hotMinutes: 60, oldChars: 120, ageLabels: true, recencyRule: true },
];

function describeRefs(messageId?: number | null, replyToMessageId?: number | null): string {
  if (messageId === null || messageId === undefined) return '';
  const reply = replyToMessageId !== null && replyToMessageId !== undefined ? `, replyTo ${replyToMessageId}` : '';
  return ` [msg ${messageId}${reply}]`;
}

function ageLabel(now: number, createdAt: string): string {
  const minutes = Math.max(1, Math.round((now - new Date(createdAt).getTime()) / 60000));
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest >= 5 ? `${hours}ч${rest}м` : `${hours}ч`;
}

function buildTranscript(rows: Row[], now: number, scheme: Scheme): string {
  return rows
    .map((row) => {
      const ids = describeRefs(row.messageId, row.replyToMessageId);
      const label = row.role === 'assistant' ? 'бот' : row.userId !== null ? `${row.userName} (${row.userId})` : row.userName ?? 'участник';
      let text = row.content ?? '';
      if (scheme.oldChars !== undefined && scheme.hotMinutes !== undefined) {
        const ageMin = (now - new Date(row.createdAt).getTime()) / 60000;
        if (ageMin > scheme.hotMinutes && text.length > scheme.oldChars) {
          text = `${text.slice(0, scheme.oldChars).trim()}…`;
        }
      }
      const age = scheme.ageLabels ? `[${ageLabel(now, row.createdAt)} назад] ` : '';
      return `${age}${label}${ids}: ${text}`;
    })
    .join('\n');
}

function directive(scheme: Scheme): string {
  const base = 'Отвечай участнику, который к тебе обратился; id в ответ не пиши. По имени обращайся не всегда.';
  if (!scheme.recencyRule) return base;
  const hot = scheme.hotMinutes ?? 60;
  return `${base} В расшифровке у каждой реплики указано, сколько времени назад она была. Свежие реплики важнее: опирайся на последние сообщения и текущую тему, а старые (старше ${hot} мин) — только фон. Не возвращайся к закрытым темам и не тяни старый контекст, если свежие реплики его не продолжают.`;
}

const JUDGE_SYSTEM = `Ты — строгий аудитор ответов Telegram-бота-тролля. Тебе дают КОНТЕКСТ (расшифровку с временем) и ОТВЕТ бота.
Оцени:
- recency_focus (0..1): ответ реагирует на СВЕЖИЕ/последние реплики и текущую тему, а не на старые/закрытые;
- quality (0..1): ответ по делу, остроумный, в образе;
- dragged_old (true/false): тянет ли закрытую старую тему без повода.
Отвечай строго JSON: {"recency_focus":0.0,"quality":0.0,"dragged_old":false,"verdict":"одна фраза"}`;

async function generate(transcript: string, dir: string): Promise<string> {
  const raw = await call(
    [
      { role: 'system', content: JERK_PROMPT },
      { role: 'user', content: `${wrapUserContent(transcript)}\n\n${dir}` },
    ],
    { temperature: 1.05, maxTokens: 300, reasoningEffort: 'none', label: 'свежесть' }
  );
  return sanitizeModelText(raw ?? '', 400).toLowerCase();
}

async function judge(transcript: string, answer: string): Promise<{ recency_focus: number; quality: number; dragged_old: boolean }> {
  const raw = await call(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: `КОНТЕКСТ:\n${transcript}\n\nОТВЕТ бота:\n${answer}\n\nВерни JSON.` },
    ],
    { model: JUDGE_MODEL, temperature: 0, maxTokens: 1500, json: true, reasoningEffort: 'none', label: 'судья свежести' }
  );
  const parsed = parseJson<Record<string, unknown>>(raw);
  return {
    recency_focus: Number(parsed?.recency_focus) || 0,
    quality: Number(parsed?.quality) || 0,
    dragged_old: parsed?.dragged_old === true,
  };
}

async function main(): Promise<void> {
  const agg = new Map<string, { recency: number; quality: number; dragged: number; n: number; chars: number }>();
  const details: unknown[] = [];

  for (const id of CASE_IDS) {
    const targetIndex = history.findIndex((row) => row.messageId === id && row.role === 'user');
    if (targetIndex < 0) continue;
    const target = history[targetIndex];
    const now = new Date(target.createdAt).getTime();
    const rows = history.slice(0, targetIndex + 1);
    const focus = { userId: Number(target.userId), userName: target.userName ?? 'участник' };

    for (const scheme of SCHEMES) {
      const transcript = buildTranscript(rows, now, scheme);
      const dir = `${directive(scheme)} Обращается: ${focus.userName} (${focus.userId}), он к тебе обратился.`;
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const answer = await generate(transcript, dir);
        const verdict = await judge(transcript, answer);
        const acc = agg.get(scheme.name) ?? { recency: 0, quality: 0, dragged: 0, n: 0, chars: 0 };
        acc.recency += verdict.recency_focus;
        acc.quality += verdict.quality;
        acc.dragged += verdict.dragged_old ? 1 : 0;
        acc.n += 1;
        acc.chars += transcript.length;
        agg.set(scheme.name, acc);
        details.push({ case: id, scheme: scheme.name, transcriptChars: transcript.length, answer, ...verdict });
        console.log(`[${id}] ${scheme.name}: recency=${verdict.recency_focus.toFixed(2)} quality=${verdict.quality.toFixed(2)} draggedOld=${verdict.dragged_old}`);
      }
    }
  }

  console.log('\n===== СХЕМЫ УЧЁТА СВЕЖЕСТИ =====');
  console.log('схема | recency_focus | качество | тянет старое | символов');
  for (const scheme of SCHEMES) {
    const acc = agg.get(scheme.name)!;
    console.log(
      `${scheme.name.padEnd(24)} | ${(acc.recency / acc.n).toFixed(2).padStart(13)} | ${(acc.quality / acc.n).toFixed(2).padStart(8)} | ${acc.dragged}/${acc.n} | ${(acc.chars / acc.n).toFixed(0)}`
    );
  }

  writeFileSync(OUT_FILE, JSON.stringify({ schemes: SCHEMES, summary: [...agg.entries()], details }, null, 2));
  console.log(`\nДетали: ${OUT_FILE}`);
}

void main();
