/**
 * Тюнинг жизненного цикла био: выбор окна обновления и схемы затухания.
 *
 * Идея (по практикам Park et al. / MemoryBank / Mem0 / AWS):
 *  - важность факта оценивает модель при извлечении (1..5);
 *  - затухание = редкость(recency) × важность(importance) × частота(access);
 *  - вымывание мягкое: ниже порога факт уходит, но может вернуться.
 *
 * Фаза 1: извлекаем факты (с важностью) по окну W=10 и кэшируем.
 * Фаза 2: детерминированно прогоняем разные ЧАСТОТЫ обновления (каждые
 *         10/20/30 сообщений) и СХЕМЫ затухания — без обращений к модели.
 * Фаза 3: метрики на пользователя и по всем вместе, выбор лучшей схемы.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-tuning.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { wrapUserContent } from '../../src/app/modules/troll/utils/troll-sanitizer';
import { call, parseJson, withTag } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const CACHE_FILE = process.env.BIO_TUNING_CACHE || '/tmp/opencode/bio-tuning-cache.json';
const W = 10; // окно извлечения фактов (сообщений)
const TOP = Number(process.env.BIO_TUNING_TOP || 4);
const SIM = 0.6;

const EXTRACT_PROMPT = `Из новых реплик участника Telegram-чата извлеки САМЫЕ ЗНАЧИМЫЕ устойчивые факты о нём. Верни строго JSON:
{"facts": [{"text": "факт", "importance": 1-5}]} — не больше 6 фактов.

importance — насколько сведение ДОЛГОВЕЧНО и важно для профиля (5 — работа/место/характер, 1 — разовая мелочь).
Правила:
- Факты — только о САМОМ участнике: занятия, работа, стек, место, интересы, привычки, повторяющиеся темы, манера общения.
- НЕ включай разовые мелочи, слова-паразиты и выражения, разовые бытовые детали, чужие дела.
- Только то, что реально следует из реплик. Не выдумывай.
- О других людях — обобщённо; их персональные данные (адреса, госномера, документы, телефоны, точные даты рождения, ФИО) не извлекай.
- Каждый факт — короткая фраза до 80 символов, одна мысль.
- Если факт уже есть в текущем досье (оно дано ниже) — переформулируй его ТОЧНО как в досье.`;

interface Row {
  id: number;
  role: string;
  userId: number | null;
  userName: string | null;
  content: string;
  createdAt: string;
}

interface ExtractedFact {
  text: string;
  importance: number;
}

interface CacheEntry {
  userId: number;
  name: string;
  chunks: ExtractedFact[][];
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

function similarity(a: string, b: string): number {
  const left = new Set(tokenSet(a));
  const right = new Set(tokenSet(b));
  if (left.size < 2 || right.size < 2) return 0;
  let matched = 0;
  for (const token of left) {
    for (const other of right) {
      if (
        token === other ||
        (token.length >= 4 && other.length >= 4 && (token.startsWith(other) || other.startsWith(token)))
      ) {
        matched += 1;
        break;
      }
    }
  }
  return matched / Math.min(left.size, right.size);
}

async function extract(name: string, dossier: string[], rows: Row[]): Promise<ExtractedFact[]> {
  const user = [
    `Участник: ${name}`,
    `Текущее досье:`,
    dossier.length ? dossier.map((fact) => `- ${fact}`).join('\n') : '—',
    '',
    `Новые реплики участника:`,
    rows.map((row, index) => `${index + 1}) ${(row.content ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim()}`).join('\n'),
  ].join('\n');

  const raw = await call(
    [{ role: 'system', content: EXTRACT_PROMPT }, { role: 'user', content: wrapUserContent(user) }],
    { temperature: 0.2, maxTokens: 800, json: true, reasoningEffort: 'none', label: `факты ${name}` }
  );
  const parsed = parseJson<{ facts?: unknown }>(raw);
  const facts = Array.isArray(parsed?.facts) ? parsed!.facts : [];
  return facts
    .map((fact): ExtractedFact | null => {
      if (typeof fact === 'string') return { text: fact.trim().slice(0, 120), importance: 3 };
      if (fact && typeof fact === 'object') {
        const record = fact as { text?: unknown; importance?: unknown };
        const text = typeof record.text === 'string' ? record.text.trim().slice(0, 120) : '';
        const importance = Math.max(1, Math.min(5, Math.round(Number(record.importance) || 3)));
        return text.length >= 3 ? { text, importance } : null;
      }
      return null;
    })
    .filter((fact): fact is ExtractedFact => fact !== null && !looksLikePii(fact.text));
}

/** Фаза 1: извлечение с кэшем на диск. */
async function buildCache(): Promise<CacheEntry[]> {
  if (existsSync(CACHE_FILE)) {
    console.log(`Кэш извлечения: ${CACHE_FILE}`);
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CacheEntry[];
  }
  const users = [...byUser().entries()]
    .filter(([, value]) => value.rows.length >= W)
    .sort((a, b) => b[1].rows.length - a[1].rows.length)
    .slice(0, TOP);

  const cache: CacheEntry[] = [];
  for (const [userId, { name, rows }] of users) {
    const chunks = chunk(rows, W);
    const out: ExtractedFact[][] = [];
    let dossier: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const facts = await withTag(`извлечение ${name} ${i + 1}`, () => extract(name, dossier, chunks[i]));
      out.push(facts);
      dossier = [...new Set([...dossier, ...facts.map((fact) => fact.text)])];
      console.log(`${name}: окно ${i + 1}/${chunks.length} — ${facts.length} фактов`);
    }
    cache.push({ userId, name, chunks: out });
  }
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

/* ------------------------------------------------------------------ */
/* Фаза 2: реестр фактов и симуляция схем                              */
/* ------------------------------------------------------------------ */

interface RegistryFact {
  id: number;
  text: string;
  importance: number;
  /** Номера окон (в единицах W), где факт встречался. */
  chunks: Set<number>;
}

function buildRegistry(entry: CacheEntry): { registry: RegistryFact[]; chunkFactIds: number[][] } {
  const registry: RegistryFact[] = [];
  const chunkFactIds: number[][] = [];

  entry.chunks.forEach((facts, chunkIndex) => {
    const ids: number[] = [];
    for (const fact of facts) {
      let best: RegistryFact | null = null;
      let bestScore = 0;
      for (const reg of registry) {
        const score = similarity(fact.text, reg.text);
        if (score > bestScore) {
          bestScore = score;
          best = reg;
        }
      }
      if (best && bestScore >= SIM) {
        best.chunks.add(chunkIndex);
        best.importance = Math.max(best.importance, fact.importance);
        ids.push(best.id);
      } else {
        const reg: RegistryFact = {
          id: registry.length,
          text: fact.text,
          importance: fact.importance,
          chunks: new Set([chunkIndex]),
        };
        registry.push(reg);
        ids.push(reg.id);
      }
    }
    chunkFactIds.push(ids);
  });

  return { registry, chunkFactIds };
}

interface SchemeConfig {
  name: string;
  /** Период полураспада (в окнах обновления) для факта с данным профилем. */
  halfLife: (count: number, importance: number) => number;
  dropThreshold: number;
  confirmBoost: (importance: number) => number;
  maxWeight: number;
  initialWeight: (importance: number) => number;
}

const SCHEMES: SchemeConfig[] = [
  {
    name: 'A: count-only (текущая)',
    halfLife: (count) => Math.min(12, 2 * 2 ** Math.max(0, count - 1)),
    dropThreshold: 0.3,
    confirmBoost: () => 1,
    maxWeight: 4,
    initialWeight: () => 1,
  },
  {
    name: 'B: importance×halfLife',
    halfLife: (count, importance) => Math.min(16, (1 + importance) * 2 ** Math.max(0, count - 1)),
    dropThreshold: 0.3,
    confirmBoost: () => 1,
    maxWeight: 4,
    initialWeight: () => 1,
  },
  {
    name: 'C: importance-weighted (Mem0)',
    halfLife: () => 8,
    dropThreshold: 0.8,
    confirmBoost: (importance) => importance / 2,
    maxWeight: 8,
    initialWeight: (importance) => importance,
  },
];

interface SchemeMetrics {
  coreSize: number;
  durableCoverage: number;
  noise: number;
  regret: number;
  callsPerUser: number;
}

function simulate(
  entry: CacheEntry,
  chunkFactIds: number[][],
  registry: RegistryFact[],
  cadence: number,
  scheme: SchemeConfig
): SchemeMetrics {
  const batches: number[][] = [];
  for (let i = 0; i < entry.chunks.length; i += cadence) {
    const union = new Set<number>();
    for (let j = i; j < Math.min(i + cadence, entry.chunks.length); j += 1) {
      chunkFactIds[j].forEach((id) => union.add(id));
    }
    batches.push([...union]);
  }

  const count = new Map<number, number>();
  const weight = new Map<number, number>();
  const lastSeen = new Map<number, number>();
  let regret = 0;

  for (let b = 0; b < batches.length; b += 1) {
    const confirmed = new Set<number>();
    for (const id of batches[b]) {
      const importance = registry[id].importance;
      if (count.has(id)) {
        count.set(id, count.get(id)! + 1);
        weight.set(id, Math.min(scheme.maxWeight, weight.get(id)! + scheme.confirmBoost(importance)));
      } else {
        count.set(id, 1);
        weight.set(id, scheme.initialWeight(importance));
      }
      lastSeen.set(id, b);
      confirmed.add(id);
    }
    // распад
    for (const id of [...weight.keys()]) {
      if (confirmed.has(id)) continue;
      const hl = scheme.halfLife(count.get(id) ?? 1, registry[id].importance);
      weight.set(id, weight.get(id)! * 0.5 ** (1 / Math.max(0.5, hl)));
    }
    // вымывание
    for (const id of [...weight.keys()]) {
      if (!confirmed.has(id) && weight.get(id)! < scheme.dropThreshold) {
        // если факт вернётся позже — это «сожаление» о преждевременном вымывании
        const seenChunks = [...registry[id].chunks].some((c) => c > (lastSeen.get(id) ?? 0) * cadence);
        if (seenChunks) regret += 1;
        count.delete(id);
        weight.delete(id);
        lastSeen.delete(id);
      }
    }
  }

  const core = [...count.keys()].filter((id) => (count.get(id) ?? 0) >= 2);
  // durable = факты, встреченные в >=3 разных окнах извлечения
  const durable = registry.filter((reg) => reg.chunks.size >= 3).map((reg) => reg.id);
  const durablePresent = durable.filter((id) => count.has(id));
  const durableCovered = core.filter((id) => durable.includes(id));

  return {
    coreSize: core.length,
    durableCoverage: durablePresent.length ? durableCovered.length / durablePresent.length : 0,
    noise: core.filter((id) => !durable.includes(id)).length,
    regret,
    callsPerUser: batches.length,
  };
}

async function main(): Promise<void> {
  const cache = await buildCache();
  const cadences = [1, 2, 3]; // обновление каждые 10 / 20 / 30 сообщений

  const rows: Array<{ scheme: string; cadence: number; avgCore: number; coverage: number; noise: number; regret: number; calls: number }> = [];
  for (const scheme of SCHEMES) {
    for (const cadence of cadences) {
      const all = cache.map((entry) => {
        const { registry, chunkFactIds } = buildRegistry(entry);
        return simulate(entry, chunkFactIds, registry, cadence, scheme);
      });
      const avg = (pick: (m: SchemeMetrics) => number) => all.reduce((s, m) => s + pick(m), 0) / all.length;
      rows.push({
        scheme: scheme.name,
        cadence,
        avgCore: avg((m) => m.coreSize),
        coverage: avg((m) => m.durableCoverage),
        noise: avg((m) => m.noise),
        regret: avg((m) => m.regret),
        calls: avg((m) => m.callsPerUser),
      });
    }
  }

  console.log('\n===== СРАВНЕНИЕ СХЕМ (среднее по пользователям) =====');
  console.log('схема | обновл. | ядро | покрытие durable | шум | regret | LLM-вызовов/юзер');
  for (const row of rows) {
    console.log(
      `${row.scheme.padEnd(38)} | ${(row.cadence * W).toString().padStart(2)} сообщ. | ` +
        `${row.avgCore.toFixed(1).padStart(4)} | ${(row.coverage * 100).toFixed(0).padStart(3)}% | ` +
        `${row.noise.toFixed(1).padStart(4)} | ${row.regret.toFixed(1).padStart(3)} | ${row.calls.toFixed(1)}`
    );
  }

  // Лучшая схема: максимум покрытия stable-facts при минимуме regret и шума, при меньшей цене.
  const score = (r: (typeof rows)[number]) =>
    r.coverage * 2 - r.regret * 0.1 - r.noise * 0.02 - r.calls * 0.01;
  const best = [...rows].sort((a, b) => score(b) - score(a))[0];
  console.log(`\nЛучший вариант: ${best.scheme}, обновление каждые ${best.cadence * W} сообщ.`);
}

void main();
