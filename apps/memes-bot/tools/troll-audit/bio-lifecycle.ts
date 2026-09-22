/**
 * Эволюция био с ДЕТЕРМИНИРОВАННЫМ жизненным циклом и ПЕРИОДОМ ПОЛУРАСПАДА.
 *
 * LLM только извлекает факты из новых реплик; всё остальное считает КОД:
 *  - у каждого факта есть «вес» (сила памяти);
 *  - подтверждение повышает вес и замедляет распад (важные факты живут дольше);
 *  - без подтверждения вес экспоненциально падает: за halfLife окон он делится
 *    вдвое; когда вес проваливается ниже порога — факт вымывается из ядра;
 *  - период полураспада зависит от важности факта (числа подтверждений);
 *  - PII отсекается детерминированно.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-lifecycle.ts
 */

import { readFileSync } from 'node:fs';
import { wrapUserContent } from '../../src/app/modules/troll/utils/troll-sanitizer';
import { call, parseJson, withTag } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const BIO_EVERY = 10;
const TOP = Number(process.env.BIO_EVO_TOP || 3);
const CORE_MIN = 2; // сколько подтверждений — факт считается ядром
const SIM_THRESHOLD = 0.6;

/** Сила памяти: стартовый вес и потолок при подтверждениях. */
const INITIAL_WEIGHT = 1;
const CONFIRM_BOOST = 1;
const MAX_WEIGHT = 4;
/** Базовый период полураспада (в окнах) для факта, подтверждённого однажды. */
const BASE_HALF_LIFE = 2;
/** Потолок периода полураспада, окон. */
const MAX_HALF_LIFE = 12;
/** Ниже этого веса факт вымывается из ядра. */
const DROP_THRESHOLD = 0.3;

const EXTRACT_PROMPT = `Из новых реплик участника Telegram-чата извлеки САМЫЕ ЗНАЧИМЫЕ устойчивые факты о нём. Верни строго JSON: {"facts": ["факт", ...]} — не больше 6 фактов.

Правила:
- Факты — только о САМОМ участнике: занятия, работа, стек, место, интересы, привычки, повторяющиеся темы, манера общения.
- Отдавай приоритет долговечным сведениям. НЕ включай разовые мелочи, слова-паразиты и выражения («использует слово кайф»), разовые бытовые детали, чужие дела.
- Только то, что реально следует из реплик. Не выдумывай.
- О других людях — в лучшем случае обобщённо; их персональные данные (адреса, госномера, документы, телефоны, точные даты рождения, ФИО) не извлекай.
- Каждый факт — короткая фраза до 80 символов, одна мысль. Без оценок и оскорблений.
- Не повторяй один факт дважды.
- Если подходящий факт уже есть в текущем досье (оно дано ниже) — переформулируй его ТОЧНО как в досье, чтобы не было дубля.`;

interface Row {
  id: number;
  role: string;
  userId: number | null;
  userName: string | null;
  content: string;
  createdAt: string;
}

interface StoredFact {
  text: string;
  /** Сколько окон факт был подтверждён (важность). */
  count: number;
  firstStep: number;
  lastStep: number;
  /** Сила памяти: 0..MAX_WEIGHT, падает без подтверждений. */
  weight: number;
}

/** Период полураспада факта (в окнах): растёт с важностью (числом подтверждений). */
function halfLife(count: number): number {
  return Math.min(MAX_HALF_LIFE, BASE_HALF_LIFE * 2 ** Math.max(0, count - 1));
}

/** Вес факта за одно окно без подтверждения: 0.5^(1/halfLife). */
function decayFactor(count: number): number {
  return 0.5 ** (1 / halfLife(count));
}

const history: Row[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));

function byUser(): Map<number, { name: string; rows: Row[] }> {
  const map = new Map<number, { name: string; rows: Row[] }>();
  for (const row of history) {
    if (row.role !== 'user' || row.userId === null) continue;
    const id = Number(row.userId);
    const entry = map.get(id) ?? { name: row.userName ?? `id ${id}`, rows: [] };
    entry.rows.push(row);
    if (row.userName) entry.name = row.userName;
    map.set(id, entry);
  }
  return map;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function looksLikePii(text: string): boolean {
  const patterns = [
    /\b\d{2}[.\-/]\d{2}[.\-/]\d{4}\b/,
    /\b[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}\b/i,
    /(\+7|\b8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/,
    /(\bпаспорт\w*|\bснилс\w*|\bинн\b)[^\n]{0,25}\d/i,
    /\b\d{3}-\d{3}-\d{3}\s*\d{2}\b/,
    /(ул\.|улиц\w+|проспект\w*|переул\w+|шоссе|д\.\s*\d|дом\s*\d|кв\.\s*\d|квартир\w*\s*№?\s*\d)/i,
    /(адрес|проживан\w*|пропис\w*)[^\n]{0,30}\d/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function tokenSet(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

/** Похожесть фактов: доля совпавших слов (с учётом префиксов). */
function similarity(a: string, b: string): number {
  const leftSet = new Set(tokenSet(a));
  const right = new Set(tokenSet(b));
  if (leftSet.size < 2 || right.size < 2) return 0;
  let matched = 0;
  for (const token of leftSet) {
    for (const other of right) {
      if (token === other || (token.length >= 4 && other.length >= 4 && (token.startsWith(other) || other.startsWith(token)))) {
        matched += 1;
        break;
      }
    }
  }
  return matched / Math.min(leftSet.size, right.size);
}

async function extractFacts(name: string, dossier: string[], rows: Row[]): Promise<string[]> {
  const user = [
    `Участник: ${name}`,
    `Текущее досье:`,
    dossier.length ? dossier.map((fact) => `- ${fact}`).join('\n') : '—',
    '',
    `Новые реплики участника:`,
    rows.map((row, index) => `${index + 1}) ${(row.content ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim()}`).join('\n'),
  ].join('\n');

  const raw = await call(
    [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: wrapUserContent(user) },
    ],
    { temperature: 0.2, maxTokens: 800, json: true, reasoningEffort: 'none', label: `факты ${name}` }
  );
  const parsed = parseJson<{ facts?: unknown }>(raw);
  const facts = Array.isArray(parsed?.facts) ? parsed!.facts : [];
  return facts
    .filter((fact): fact is string => typeof fact === 'string')
    .map((fact) => fact.trim().slice(0, 120))
    .filter((fact) => fact.length >= 3);
}

async function evolve(name: string, rows: Row[]): Promise<void> {
  const chunks = chunk(rows, BIO_EVERY);
  console.log(`\n################ ${name} — ${rows.length} реплик, ${chunks.length} обновлений ################`);

  let stored: StoredFact[] = [];
  for (let step = 1; step <= chunks.length; step += 1) {
    const candidates = await withTag(`факты ${name} ${step}`, () =>
      extractFacts(name, stored.map((fact) => fact.text), chunks[step - 1])
    );
    const pii = candidates.filter(looksLikePii);
    const clean = candidates.filter((fact) => !looksLikePii(fact));

    const added: StoredFact[] = [];
    const promoted: StoredFact[] = [];
    const held: StoredFact[] = [];
    const confirmedNow = new Set<StoredFact>();

    for (const candidate of clean) {
      let best: StoredFact | null = null;
      let bestScore = 0;
      for (const fact of stored) {
        const score = similarity(candidate, fact.text);
        if (score > bestScore) {
          bestScore = score;
          best = fact;
        }
      }
      if (best && bestScore >= SIM_THRESHOLD) {
        const wasCore = best.count >= CORE_MIN;
        best.count += 1;
        best.lastStep = step;
        best.weight = Math.min(MAX_WEIGHT, best.weight + CONFIRM_BOOST);
        confirmedNow.add(best);
        if (!wasCore && best.count >= CORE_MIN) promoted.push(best);
        else if (wasCore) held.push(best);
      } else {
        const fact: StoredFact = {
          text: candidate,
          count: 1,
          firstStep: step,
          lastStep: step,
          weight: INITIAL_WEIGHT,
        };
        stored.push(fact);
        added.push(fact);
      }
    }

    // Распад: каждый факт без подтверждения теряет вес по своему периоду полураспада.
    const fading: StoredFact[] = [];
    for (const fact of stored) {
      if (confirmedNow.has(fact)) continue;
      fact.weight *= decayFactor(fact.count);
      if (fact.weight >= DROP_THRESHOLD && fact.weight < 0.5) fading.push(fact);
    }

    // Вымывание: вес провалился ниже порога — факт уходит из ядра.
    const gone = stored.filter((fact) => fact.weight < DROP_THRESHOLD);
    stored = stored.filter((fact) => fact.weight >= DROP_THRESHOLD);

    console.log(`\n================ ОБНОВЛЕНИЕ ${step}/${chunks.length} (сообщ. ${step * BIO_EVERY}) ================`);
    for (const fact of added) {
      console.log(`  + [НОВЫЙ] ${fact.text} (вес ${fact.weight.toFixed(2)}, полураспад ${halfLife(fact.count)} окон)`);
    }
    for (const fact of promoted) {
      console.log(`  ★ [ЗАКРЕПЛЁН → ядро] ${fact.text} (×${fact.count}, полураспад ${halfLife(fact.count)} окон)`);
    }
    if (held.length) console.log(`  = [ядро] подтверждено сейчас: ${held.length}`);
    for (const fact of fading) {
      console.log(`  ~ [угасает] ${fact.text} (вес ${fact.weight.toFixed(2)}, будет вымыт)`);
    }
    for (const fact of gone) console.log(`  − [ВЫМЫТ] ${fact.text} (вес ${fact.weight.toFixed(2)})`);
    for (const fact of [...new Set(pii)]) console.log(`  ⚠ [PII ОТСЕЧЁН] ${fact}`);
  }

  const core = stored.filter((fact) => fact.count >= CORE_MIN).sort((a, b) => b.weight - a.weight);
  console.log(`\n--- ЯДРО (${core.length} фактов, с весом) ---`);
  for (const fact of core) {
    console.log(`  • [×${fact.count} w=${fact.weight.toFixed(2)} hl=${halfLife(fact.count)}] ${fact.text}`);
  }
}

async function main(): Promise<void> {
  const users = [...byUser().entries()]
    .filter(([, value]) => value.rows.length >= BIO_EVERY)
    .sort((a, b) => b[1].rows.length - a[1].rows.length)
    .slice(0, TOP);
  for (const [, { name, rows }] of users) {
    await evolve(name, rows);
  }
}

void main();
