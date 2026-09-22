/**
 * Эксперимент: размер био → польза в ответах бота.
 *
 * Берём стабильные факты участника (из кэша извлечения), собираем био разного
 * бюджета (0/300/800/1500 символов), подмешиваем в диалоговый промпт и просим
 * судью (старшая модель) оценить ответ по персонализации и качеству.
 *
 * Контекст намеренно обрезан (последние 6 реплик), чтобы факты «долгой памяти»
 * не были доступны из 24-часовой истории — тогда видно вклад именно био.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-effect.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  CONVERSATION_PAUSE_RULE,
  JERK_PROMPT,
  MESSAGE_REFS_RULE,
} from '../../src/app/modules/troll/constants/troll-prompts';
import {
  sanitizeModelText,
  wrapUserContent,
} from '../../src/app/modules/troll/utils/troll-sanitizer';
import {
  buildConversationContext,
  formatConversationPause,
} from '../../src/app/modules/troll/utils/troll-context';
import { JUDGE_MODEL, call, parseJson } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const CACHE_FILE = process.env.BIO_TUNING_CACHE || '/tmp/opencode/bio-tuning-cache.json';
const OUT_FILE = process.env.BIO_EFFECT_OUT || '/tmp/opencode/bio-effect.json';

const BUDGETS = (process.env.BIO_EFFECT_BUDGETS || '0,500,1000').split(',').map((v) => Number(v.trim()));
const SCOPES: Array<'stable' | 'all'> = (process.env.BIO_EFFECT_SCOPES || 'stable,all').split(',') as Array<'stable' | 'all'>;
const VARIANT = (process.env.BIO_EFFECT_VARIANT || 'tail') as InjectionVariant;
const CONTEXT_ROWS = 6;
const SAMPLES = Number(process.env.BIO_EFFECT_SAMPLES || 2);
const SIM = 0.6;

/** Обращения к боту (messageId) из реальной истории чата mems. */
const CASE_IDS = [21466, 21468, 21470, 21474, 21484];

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

/* ---------------- реестр фактов из кэша извлечения ---------------- */

interface ExtractedFact {
  text: string;
  importance: number;
}
export interface CacheEntry {
  userId: number;
  name: string;
  chunks: ExtractedFact[][];
}

function tokenSet(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}
function similarity(a: string, b: string): number {
  const left = new Set(tokenSet(a));
  const right = new Set(tokenSet(b));
  if (left.size < 2 || right.size < 2) return 0;
  let matched = 0;
  for (const token of left) {
    for (const other of right) {
      if (token === other || (token.length >= 4 && other.length >= 4 && (token.startsWith(other) || other.startsWith(token)))) {
        matched += 1;
        break;
      }
    }
  }
  return matched / Math.min(left.size, right.size);
}

export interface RankedFact {
  text: string;
  importance: number;
  occurrences: number;
  score: number;
}

export function rankFacts(entry: CacheEntry, minOccurrences = 2): RankedFact[] {
  const reg: Array<{ text: string; importance: number; chunks: Set<number> }> = [];
  entry.chunks.forEach((facts, chunkIndex) => {
    for (const fact of facts) {
      let best: (typeof reg)[number] | null = null;
      let bestScore = 0;
      for (const item of reg) {
        const score = similarity(fact.text, item.text);
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (best && bestScore >= SIM) {
        best.chunks.add(chunkIndex);
        best.importance = Math.max(best.importance, fact.importance);
      } else {
        reg.push({ text: fact.text, importance: fact.importance, chunks: new Set([chunkIndex]) });
      }
    }
  });
  return reg
    .map((item) => ({
      text: item.text,
      importance: item.importance,
      occurrences: item.chunks.size,
      score: item.importance * (1 + Math.log1p(item.chunks.size)),
    }))
    .filter((fact) => fact.occurrences >= minOccurrences)
    .sort((a, b) => b.score - a.score);
}

export function bioFor(facts: RankedFact[], budget: number): string {
  if (budget <= 0) return '';
  const picked: string[] = [];
  let used = 0;
  for (const fact of facts) {
    const line = `- ${fact.text}`;
    if (used + line.length + 1 > budget) break;
    picked.push(line);
    used += line.length + 1;
  }
  return picked.join('\n');
}

/* ---------------- сборка контекста и ответа ---------------- */

function describeRefs(messageId?: number | null, replyToMessageId?: number | null): string {
  if (messageId === null || messageId === undefined) return '';
  const reply = replyToMessageId !== null && replyToMessageId !== undefined ? `, replyTo ${replyToMessageId}` : '';
  return ` [msg ${messageId}${reply}]`;
}

function buildTranscript(rowsNewestFirst: Row[]): string {
  const context = buildConversationContext(
    rowsNewestFirst.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })),
    { gapMs: 15 * 60 * 1000, maxTurns: 100, maxChars: 20000 }
  );
  return context
    .map((item) => {
      if (item.kind === 'pause') return `—— разрыв беседы, пауза ${formatConversationPause(item.gapMs)} ——`;
      const row = item.row;
      const ids = describeRefs(row.messageId, row.replyToMessageId);
      if (row.role === 'assistant') return `бот${ids}: ${row.content}`;
      const name = row.userName ?? 'участник';
      return row.userId !== null ? `${name} (${row.userId})${ids}: ${row.content}` : `${name}${ids}: ${row.content}`;
    })
    .join('\n');
}

const BIO_HEADER = `Фон-досье (долгая память о собеседниках). Используй уместно и ненавязчиво, как будто просто помнишь человека. НЕ цитируй досье дословно, НЕ перечисляй его списком и НЕ показывай, что ведёшь записи.`;

interface Case {
  target: Row;
  focus: { userId: number; userName: string };
  transcript: string;
  directive: string;
}

export type InjectionVariant = 'top' | 'system' | 'tail';

export function buildCases(): Case[] {
  const cases: Case[] = [];
  for (const id of CASE_IDS) {
    const targetIndex = history.findIndex((row) => row.messageId === id && row.role === 'user');
    if (targetIndex < 0) continue;
    const target = history[targetIndex];
    const focus = { userId: Number(target.userId), userName: target.userName ?? 'участник' };
    const contextRows = history.slice(0, targetIndex + 1).reverse().slice(0, CONTEXT_ROWS);
    const transcript = buildTranscript(contextRows);
    const directive = `Отвечай участнику «${focus.userName} (${focus.userId})» — он к тебе обратился, id в ответ не пиши. По имени обращайся не всегда. ${MESSAGE_REFS_RULE} ${CONVERSATION_PAUSE_RULE}`;
    cases.push({ target, focus, transcript, directive });
  }
  return cases;
}

export async function generate(testCase: Case, bio: string, variant: InjectionVariant = 'top'): Promise<string> {
  const bioBlock = bio
    ? `${BIO_HEADER}\n${testCase.focus.userName} (${testCase.focus.userId}):\n${bio}`
    : '';
  const baseUser = `${wrapUserContent(testCase.transcript)}\n\n${testCase.directive}`;
  let system = JERK_PROMPT;
  let user = baseUser;
  if (bioBlock && variant === 'top') {
    user = `${bioBlock}\n\n${baseUser}`;
  } else if (bioBlock && variant === 'system') {
    system = `${JERK_PROMPT}\n\n${bioBlock}`;
  } else if (bioBlock && variant === 'tail') {
    user = `${baseUser}\n\n${bioBlock}\n\nЕсли в досье есть уместный факт о собеседнике — обязательно обыграй его.`;
  }
  const raw = await call(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 1.05, maxTokens: 300, reasoningEffort: 'none', label: `эффект ${testCase.target.messageId}` }
  );
  return sanitizeModelText(raw ?? '', 400).toLowerCase();
}

const JUDGE_SYSTEM = `Ты — строгий аудитор ответов Telegram-ботa-тролля. Тебе дают ЗАДАНИЕ (кто обратился и что известно о нём из долгой памяти), КОНТЕКСТ последних реплик и ОТВЕТ бота.
Оцени по трём осям (0..1):
- personalization: ответ учитывает сведения о человеке из долгой памяти уместно и естественно (как живое знание, а не справка);
- quality: ответ по делу, остроумный, в образе дерзкого бота; без выдуманных фактов;
- If долгой памяти нет — оценивай только по context, personalization=0.
Отвечай строго JSON: {"personalization":0.0,"quality":0.0,"used_bio":true,"invented":false,"verdict":"одна фраза"}`;

export async function judge(bio: string, testCase: Case, answer: string): Promise<{ personalization: number; quality: number; used_bio: boolean; invented: boolean; verdict: string }> {
  const user = [
    `ЗАДАНИЕ:\nОбращается: ${testCase.focus.userName}\nДолгая память о нём:\n${bio || '(нет)'}`,
    `КОНТЕКСТ последних реплик:\n${testCase.transcript}`,
    `ОТВЕТ бота:\n${answer}`,
    'Верни JSON по схеме.',
  ].join('\n\n');
  const raw = await call(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: user },
    ],
    { model: JUDGE_MODEL, temperature: 0, maxTokens: 1500, json: true, reasoningEffort: 'none', label: 'судья эффекта' }
  );
  const parsed = parseJson<Record<string, unknown>>(raw);
  return {
    personalization: Number(parsed?.personalization) || 0,
    quality: Number(parsed?.quality) || 0,
    used_bio: parsed?.used_bio === true,
    invented: parsed?.invented === true,
    verdict: typeof parsed?.verdict === 'string' ? parsed.verdict : '',
  };
}

async function main(): Promise<void> {
  const cache: CacheEntry[] = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  const cases = buildCases();
  console.log(`Кейсов: ${cases.length}, бюджеты: ${BUDGETS.join(', ')}, срезы: ${SCOPES.join(', ')}, впрыск: ${VARIANT}, сэмплов: ${SAMPLES}`);

  interface Acc {
    personalization: number;
    quality: number;
    used: number;
    invented: number;
    n: number;
    chars: number;
  }
  const byConfig = new Map<string, Acc>();
  const details: unknown[] = [];

  for (const testCase of cases) {
    const entry = cache.find((item) => item.userId === testCase.focus.userId);
    for (const scope of SCOPES) {
      const facts = entry ? rankFacts(entry, scope === 'all' ? 1 : 2) : [];
      for (const budget of BUDGETS) {
        if (scope === 'all' && budget === 0) continue; // дубль базовой линии без био
        const bio = budget > 0 ? bioFor(facts, budget) : '';
        for (let sample = 0; sample < SAMPLES; sample += 1) {
          const answer = await generate(testCase, bio, VARIANT);
          const verdict = await judge(bio, testCase, answer);
          const key = `${scope}:${budget}`;
          const acc = byConfig.get(key) ?? { personalization: 0, quality: 0, used: 0, invented: 0, n: 0, chars: 0 };
          acc.personalization += verdict.personalization;
          acc.quality += verdict.quality;
          acc.used += verdict.used_bio ? 1 : 0;
          acc.invented += verdict.invented ? 1 : 0;
          acc.n += 1;
          acc.chars += bio.length;
          byConfig.set(key, acc);
          details.push({ case: testCase.target.messageId, scope, budget, bioChars: bio.length, answer, ...verdict });
          console.log(
            `[${testCase.target.messageId}] ${scope}/${budget}: pers=${verdict.personalization.toFixed(2)} qual=${verdict.quality.toFixed(2)} used=${verdict.used_bio} invented=${verdict.invented} chars=${bio.length}`
          );
        }
      }
    }
  }

  console.log('\n===== БЮДЖЕТ/СРЕЗ БИО vs ПОЛЬЗА (впрыск ' + VARIANT + ') =====');
  console.log('срез/бюджет | ср. персонализация | ср. качество | использовала био | выдумок | ср. символов');
  for (const scope of SCOPES) {
    for (const budget of BUDGETS) {
      const acc = byConfig.get(`${scope}:${budget}`);
      if (!acc) continue;
      console.log(
        `${`${scope}/${budget}`.padStart(11)} | ${(acc.personalization / acc.n).toFixed(2).padStart(18)} | ${(acc.quality / acc.n).toFixed(2).padStart(12)} | ${acc.used}/${acc.n} | ${acc.invented} | ${(acc.chars / acc.n).toFixed(0)}`
      );
    }
  }

  writeFileSync(OUT_FILE, JSON.stringify({ budgets: BUDGETS, scopes: SCOPES, variant: VARIANT, byConfig: [...byConfig.entries()], details }, null, 2));
  console.log(`\nДетали: ${OUT_FILE}`);
}

if (require.main === module) {
  void main();
}
