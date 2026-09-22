/**
 * Контролируемый зонд свежести переписки.
 *
 * Склеиваем два блока реальных сообщений чата: СТАРЫЙ (тема A, ~3 ч назад)
 * и СВЕЖИЙ (тема B, только что), плюс нейтральное обращение к боту. Затем
 * детерминированно считаем, к какой теме ответ откатился (по лексикону слов).
 *
 * Так подбираем параметры: окно «свежести» (hot-хвост дословно), длину сжатия
 * старого и правило recency. Чем меньше oldHits у схемы, тем лучше она гасит
 * влияние старых сообщений.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/dialog-recency-probe.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { JERK_PROMPT } from '../../src/app/modules/troll/constants/troll-prompts';
import { sanitizeModelText, wrapUserContent } from '../../src/app/modules/troll/utils/troll-sanitizer';
import { call } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const OUT_FILE = process.env.DIALOG_PROBE_OUT || '/tmp/opencode/dialog-recency-probe.json';
const SAMPLES = Number(process.env.DIALOG_PROBE_SAMPLES || 2);

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

const TOPICS: Record<string, string[]> = {
  vpn: ['vpn', 'впн', 'сервер', 'провайдер', 'протокол', 'каскад', 'подписк', 'пинг', 'яндекс', 'хостинг', 'трафик'],
  law: ['арбитраж', 'пристав', 'исполнительн', 'суд', 'фссп', 'взыскан', 'долг', 'юрлиц', 'арест', 'заседан'],
  bots: ['бот', 'тег', 'сумариз', 'апи', 'stat', 'нарека'],
  osint: ['инн', 'фссп', 'паспорт', 'снилс', 'госномер', 'недвижим', 'квартир', 'адрес', 'наследств'],
};

interface Segment {
  rows: { row: Row; text: string; ageMin: number }[];
  ageMin: number;
}

function collect(topic: keyof typeof TOPICS, want: number, baseAgeMin: number, spanMin: number): Segment {
  const keywords = TOPICS[topic];
  const picked: Row[] = [];
  for (const row of history) {
    if (row.role !== 'user') continue;
    const text = (row.content ?? '').toLowerCase();
    if (keywords.some((k) => text.includes(k))) picked.push(row);
  }
  const rows = picked.slice(-want).map((row, index, arr) => ({
    row,
    text: row.content ?? '',
    ageMin: baseAgeMin + Math.round((spanMin * (arr.length - 1 - index)) / Math.max(1, arr.length - 1)),
  }));
  return { rows, ageMin: baseAgeMin };
}

function lexHits(text: string, topic: keyof typeof TOPICS): number {
  const lowered = text.toLowerCase();
  return TOPICS[topic].reduce((sum, k) => sum + (lowered.includes(k) ? 1 : 0), 0);
}

interface Scheme {
  name: string;
  hotMin: number; // <=0 — без меток и сжатия (flat)
  oldChars: number;
  labels: boolean;
  rule: boolean;
}

const SCHEMES: Scheme[] = [
  { name: 'flat', hotMin: 0, oldChars: 0, labels: false, rule: false },
  { name: 'drop15+rule', hotMin: 15, oldChars: 0, labels: true, rule: true },
  { name: 'drop30+rule', hotMin: 30, oldChars: 0, labels: true, rule: true },
  { name: 'drop60+rule', hotMin: 60, oldChars: 0, labels: true, rule: true },
  { name: 'hot30/60+rule', hotMin: 30, oldChars: 60, labels: true, rule: true },
];

function renderSegment(segment: Segment, scheme: Scheme): string {
  return segment.rows
    .map(({ row, text, ageMin }) => {
      let body = text;
      const old = scheme.hotMin > 0 && ageMin > scheme.hotMin;
      if (old && scheme.oldChars === 0) return null; // полное отбрасывание старого
      if (old && body.length > scheme.oldChars) {
        body = `${body.slice(0, scheme.oldChars).trim()}…`;
      }
      const age = scheme.labels ? `[${ageMin}м назад] ` : '';
      const name = row.userId !== null ? `${row.userName} (${row.userId})` : row.userName ?? 'участник';
      return `${age}${name}: ${body}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildTranscript(oldSeg: Segment, newSeg: Segment, scheme: Scheme): string {
  const question = scheme.labels ? '[0м назад] Nastia (250567587): бот, о чём мы сейчас говорим?' : 'Nastia (250567587): бот, о чём мы сейчас говорим?';
  return [renderSegment(oldSeg, scheme), '—— разрыв беседы, пауза 2 ч ——', renderSegment(newSeg, scheme), question].join('\n');
}

function ruleText(scheme: Scheme): string {
  const base = 'Отвечай участнице Nastia (она обратилась). id не пиши.';
  if (!scheme.rule) return base;
  return `${base} В расшифровке у реплик указан возраст. Свежие реплики важнее: опирайся на последние сообщения и НЕ продолжай старую тему (старше ${scheme.hotMin} мин), если свежие её не продолжают.`;
}

async function generate(transcript: string, rule: string): Promise<string> {
  const raw = await call(
    [
      { role: 'system', content: JERK_PROMPT },
      { role: 'user', content: `${wrapUserContent(transcript)}\n\n${rule}` },
    ],
    { temperature: 1.05, maxTokens: 300, reasoningEffort: 'none', label: 'зонд свежести' }
  );
  return sanitizeModelText(raw ?? '', 400).toLowerCase();
}

const PAIRS: Array<{ old: keyof typeof TOPICS; recent: keyof typeof TOPICS }> = [
  { old: 'vpn', recent: 'law' },
  { old: 'law', recent: 'bots' },
  { old: 'osint', recent: 'bots' },
];

async function main(): Promise<void> {
  const agg = new Map<string, { old: number; recent: number; n: number; chars: number }>();
  const details: unknown[] = [];

  for (const pair of PAIRS) {
    const oldSeg = collect(pair.old, 10, 180, 60); // 3 ч назад
    const newSeg = collect(pair.recent, 10, 10, 9); // только что
    for (const scheme of SCHEMES) {
      const transcript = buildTranscript(oldSeg, newSeg, scheme);
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const answer = await generate(transcript, ruleText(scheme));
        const oldHits = lexHits(answer, pair.old);
        const recentHits = lexHits(answer, pair.recent);
        const acc = agg.get(scheme.name) ?? { old: 0, recent: 0, n: 0, chars: 0 };
        acc.old += oldHits;
        acc.recent += recentHits;
        acc.n += 1;
        acc.chars += transcript.length;
        agg.set(scheme.name, acc);
        details.push({ pair: `${pair.old}->${pair.recent}`, scheme: scheme.name, oldHits, recentHits, answer });
        console.log(`[${pair.old}→${pair.recent}] ${scheme.name}: oldHits=${oldHits} recentHits=${recentHits}`);
      }
    }
  }

  console.log('\n===== ВЛИЯНИЕ СТАРОЙ ТЕМЫ (меньше oldHits — лучше) =====');
  console.log('схема | oldHits | recentHits | символов');
  for (const scheme of SCHEMES) {
    const acc = agg.get(scheme.name)!;
    console.log(
      `${scheme.name.padEnd(22)} | ${(acc.old / acc.n).toFixed(2).padStart(7)} | ${(acc.recent / acc.n).toFixed(2).padStart(10)} | ${(acc.chars / acc.n).toFixed(0)}`
    );
  }

  writeFileSync(OUT_FILE, JSON.stringify({ schemes: SCHEMES, summary: [...agg.entries()], details }, null, 2));
  console.log(`\nДетали: ${OUT_FILE}`);
}

void main();
