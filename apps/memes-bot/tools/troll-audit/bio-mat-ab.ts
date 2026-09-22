/**
 * A/B: не снижает ли био матерность ответов?
 *
 * Берём реальные обращения к боту из истории чата mems и генерируем ответ
 * N раз с био и столько же раз без био при прочих равных. Считаем долю
 * ответов, в которых есть мат (MAT_REGEX — тот же детектор, что в аудите).
 *
 * Био не пересчитываются: берутся из дампа bio-experiment.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-mat-ab.ts
 */

import { readFileSync } from 'node:fs';
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
import { MAT_REGEX } from './suites';
import { call, withTag } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const BIO_FILE = process.env.BIO_DUMP || '/tmp/opencode/bio-experiment.json';
const SAMPLES = Number(process.env.BIO_AB_SAMPLES || 3);

/** Реальные обращения к боту (messageId реплики-адресата). */
const CASE_IDS = (process.env.BIO_AB_CASES || '21466,21468,21470,21474,21484,21493,21495,21510')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter(Number.isFinite);

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

interface BioEntry {
  userId: number;
  name: string;
  bio: string;
}
const bios = new Map(
  (JSON.parse(readFileSync(BIO_FILE, 'utf8')).bios as BioEntry[])
    .filter((entry) => entry.bio)
    .map((entry) => [entry.userId, entry])
);

function describeRefs(messageId?: number | null, replyToMessageId?: number | null): string {
  if (messageId === null || messageId === undefined) return '';
  const reply =
    replyToMessageId !== null && replyToMessageId !== undefined ? `, replyTo ${replyToMessageId}` : '';
  return ` [msg ${messageId}${reply}]`;
}

function buildTranscript(rowsNewestFirst: Row[]): string {
  const context = buildConversationContext(
    rowsNewestFirst.map((row) => ({ ...row, createdAt: new Date(row.createdAt) })),
    { gapMs: 15 * 60 * 1000, maxTurns: 1500, maxChars: 48000 }
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

function directiveFor(focus: { userId: number; userName: string }): string {
  return `Отвечай участнику «${focus.userName} (${focus.userId})» — он к тебе обратился, id в ответ не пиши. По имени обращайся НЕ всегда: обычно просто отвечай по сути, а имя используй изредка (и тогда с большой буквы). В истории у каждого автора в скобках указан его id: если имена совпадают, различай собеседников по id и не приписывай одному чужие реплики. ${MESSAGE_REFS_RULE} ${CONVERSATION_PAUSE_RULE}`;
}

const BIO_INJECTION_HEADER = `Фон-досье (долгая память о собеседниках, факты из прошлых бесед). Используй уместно и ненавязчиво — как будто ты просто помнишь этих людей. НЕ цитируй досье дословно, НЕ перечисляй факты списком и НЕ показывай, что ведёшь записи.`;

function bioBlock(userIds: number[]): string {
  const lines: string[] = [];
  const seen = new Set<number>();
  let used = 0;
  for (const id of userIds) {
    const entry = bios.get(id);
    if (seen.has(id) || !entry) continue;
    seen.add(id);
    const line = `${entry.name} (${id}): ${entry.bio}`;
    if (lines.length >= 5 || (used > 0 && used + line.length > 1800)) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length ? `${BIO_INJECTION_HEADER}\n${lines.join('\n')}` : '';
}

interface CaseResult {
  id: number;
  target: string;
  withBio: string[];
  withoutBio: string[];
}

async function generate(user: string, tag: string): Promise<string> {
  const raw = await withTag(tag, () =>
    call(
      [
        { role: 'system', content: JERK_PROMPT },
        { role: 'user', content: user },
      ],
      { temperature: 1.05, maxTokens: 300, reasoningEffort: 'none', label: tag }
    )
  );
  return sanitizeModelText(raw ?? '', 400).toLowerCase();
}

async function runCase(targetMessageId: number): Promise<CaseResult | null> {
  const targetIndex = history.findIndex((row) => row.messageId === targetMessageId && row.role === 'user');
  if (targetIndex < 0) {
    console.log(`!! сообщение ${targetMessageId} не найдено`);
    return null;
  }
  const target = history[targetIndex];
  const focus = { userId: Number(target.userId), userName: target.userName ?? 'участник' };

  const contextRows = history.slice(0, targetIndex + 1).reverse();
  const participants = new Set<number>([focus.userId]);
  for (const row of contextRows) {
    if (row.role === 'user' && row.userId !== null) participants.add(Number(row.userId));
  }
  const block = bioBlock([...participants]);
  const base = `${wrapUserContent(buildTranscript(contextRows))}\n\n${directiveFor(focus)}`;
  const withBioUser = block ? `${block}\n\n${base}` : base;

  console.log(`\n### [${targetMessageId}] ${focus.userName}: ${target.content}`);
  console.log(`досье в промпте: ${block ? 'да' : 'НЕТ'}`);

  const withBio: string[] = [];
  const withoutBio: string[] = [];
  for (let sample = 1; sample <= SAMPLES; sample += 1) {
    withoutBio.push(await generate(base, `без био ${targetMessageId} #${sample}`));
    withBio.push(await generate(withBioUser, `с био ${targetMessageId} #${sample}`));
  }

  const mat = (texts: string[]) => texts.filter((text) => MAT_REGEX.test(text)).length;
  console.log(`без био: мат ${mat(withoutBio)}/${withoutBio.length}  |  с био: мат ${mat(withBio)}/${withBio.length}`);
  console.log(`  без био — пример: ${withoutBio[0]}`);
  console.log(`  с био   — пример: ${withBio[0]}`);

  return { id: targetMessageId, target: target.content ?? '', withBio, withoutBio };
}

async function main(): Promise<void> {
  console.log(`=== A/B матерности: ${CASE_IDS.length} кейсов × ${SAMPLES} сэмплов × 2 условия ===`);
  const results: CaseResult[] = [];
  for (const id of CASE_IDS) {
    const result = await runCase(id);
    if (result) results.push(result);
  }

  const flatten = (pick: (r: CaseResult) => string[]) => results.flatMap(pick);
  const without = flatten((r) => r.withoutBio);
  const withB = flatten((r) => r.withBio);
  const rate = (texts: string[]) => texts.filter((text) => MAT_REGEX.test(text)).length / texts.length;

  console.log('\n================ ИТОГ ================');
  console.log(`без био: мат в ${rate(without) * 100}% ответов (${without.length})`);
  console.log(`с био:   мат в ${rate(withB) * 100}% ответов (${withB.length})`);
  console.log(`разница: ${((rate(withB) - rate(without)) * 100).toFixed(1)} п.п.`);
}

void main();
