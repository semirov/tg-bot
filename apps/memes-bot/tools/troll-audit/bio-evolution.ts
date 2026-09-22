/**
 * Эволюция био: как факты рождаются, закрепляются и выпадают.
 *
 * Промпт ведёт «жизненный цикл» фактов: [нов] (появился), [ядро] (устойчивый),
 * [уход] (не подтверждается — удаляется). Прогоняем реплики участника чанками
 * по 10 и печатаем, что добавилось/закрепилось/умерло на каждом обновлении,
 * пока не останется стабильное ядро.
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-evolution.ts
 */

import { readFileSync } from 'node:fs';
import { wrapUserContent } from '../../src/app/modules/troll/utils/troll-sanitizer';
import { call, withTag } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const BIO_MAX_CHARS = 1000;
const BIO_EVERY = 10;
/** Сколько участников (по числу реплик) показать. */
const TOP = Number(process.env.BIO_EVO_TOP || 3);

const EVOLUTION_PROMPT = `Ты ведёшь досье на участника Telegram-чата. На вход — текущее досье и новые реплики. Верни обновлённое досье, управляя жизненным циклом фактов.

КАЖДЫЙ факт заканчивается маркером:
- [ядро] — устойчивый факт (повторяется, это постоянная черта: работа, стек, город, характер, привычки);
- [нов] — факт появился только сейчас и ещё не подтверждён;
- [уход] — факт не подтверждается и должен исчезнуть.

Правила жизненного цикла:
- Факты из текущего досье переноси ДОСЛОВНО, не перефразируй и не переставляй смысл — меняется только маркер.
- [нов] → [ядро], если факт подтверждается ещё раз в новых репликах.
- [нов] → [уход], если за это обновление он НЕ подтвердился.
- Любой факт → [уход], если он перестал подтверждаться; факт с [уход] в ответе НЕ показывай (он умер).
- [ядро] живёт, пока подтверждается или ему не противоречат.
- Новые факты добавляй, только если они реально есть в репликах. Выдумывать нельзя.
- Имя участника в досье не пиши — оно и так известно заголовку.
- Не заводи факты-заглушки («участник чата», «пишет в Telegram», «общается в чате», «ведёт Telegram») — только содержательные сведения.
- Досье — только на самого участника. О чужих людях — обобщённо, без их персональных данных (адреса, госномера, документы, телефоны, точные ДР, ФИО посторонних запрещены).
- Стиль телеграфный, каждый факт с новой строки, без вступлений и заголовков.
- Максимум ${BIO_MAX_CHARS} символов. Не влезает — сначала выкидывай [нов] и [уход], затем наименее важные [ядро].
- Ответ — только досье с маркерами, без пояснений.`;

interface Row {
  id: number;
  role: string;
  userId: number | null;
  userName: string | null;
  content: string;
  createdAt: string;
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

interface Fact {
  text: string;
  marker: 'ядро' | 'нов' | 'уход' | '?';
  pii?: boolean;
}

/** Детерминированный отсев персональных данных (страховка поверх промпта). */
function looksLikePii(text: string): boolean {
  const patterns = [
    /\b\d{2}[.\-/]\d{2}[.\-/]\d{4}\b/, // дата рождения
    /\b[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}\b/i, // госномер РФ
    /(\+7|\b8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/, // телефон
    /(\bпаспорт\w*|\bснилс\w*|\bинн\b)[^\n]{0,25}\d/i, // документ с номером
    /\b\d{3}-\d{3}-\d{3}\s*\d{2}\b/, // СНИЛС
    /(ул\.|улиц\w+|проспект\w*|переул\w+|шоссе|д\.\s*\d|дом\s*\d|кв\.\s*\d|квартир\w*\s*№?\s*\d)/i, // адрес с домом/квартирой
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function isJunkFact(text: string): boolean {
  if (/user_message/i.test(text)) return true; // модель вернула служебный делимитер
  return text.replace(/[^\p{L}\p{N}]/gu, '').length < 2; // только пунктуация/тире/мусор
}

/** Разбирает один шаг досье на факты с маркерами. */
function parseFacts(bio: string): Fact[] {
  const lines = bio
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const hasMarkers = lines.some((line) => /\[(ядро|нов|уход)\]/i.test(line));
  const parsed: Fact[] = [];

  for (const line of lines) {
    // Маркер может стоять в любом месте строки (модель иногда ставит его в середине).
    const markers = [...line.matchAll(/\[(ядро|нов|уход)\]/gi)];
    if (!hasMarkers) {
      // Фолбэк: модель не проставила маркеры — считаем всё новым, чтобы не потерять факты.
      const text = line.replace(/^[-•*\d.)\s]+/, '').trim();
      if (text && !isJunkFact(text)) parsed.push({ text, marker: 'нов', pii: looksLikePii(text) });
      continue;
    }
    if (!markers.length) continue; // обрывок без маркера — отбрасываем
    const marker = markers[markers.length - 1][1].toLowerCase() as Fact['marker'];
    const text = line.replace(/\[(ядро|нов|уход)\]/gi, ' ').replace(/^[-•*\d.)\s]+/, '').trim();
    if (text && !isJunkFact(text)) parsed.push({ text, marker, pii: looksLikePii(text) });
  }

  return parsed;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[«»"'.,;:!?]/g, '').trim();

async function updateBio(name: string, previous: string, rows: Row[]): Promise<string> {
  const user = [
    `Участник: ${name}`,
    `Текущее досье:`,
    previous || '—',
    '',
    `Новые реплики участника:`,
    rows.map((row, index) => `${index + 1}) ${(row.content ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim()}`).join('\n'),
  ].join('\n');

  const raw = await call(
    [
      { role: 'system', content: EVOLUTION_PROMPT },
      { role: 'user', content: wrapUserContent(user) },
    ],
    { temperature: 0.3, maxTokens: 900, reasoningEffort: 'none', label: `эво ${name}` }
  );
  return (raw ?? '').trim().slice(0, BIO_MAX_CHARS + 1400);
}

async function evolve(userId: number, name: string, rows: Row[]): Promise<void> {
  const chunks = chunk(rows, BIO_EVERY);
  console.log(`\n################ ${name} — ${rows.length} реплик, ${chunks.length} обновлений ################`);

  let previous = '';
  let prevFacts = new Map<string, Fact>();
  let step = 0;
  for (const chunkRows of chunks) {
    step += 1;
    previous = await withTag(`эво ${name} ${step}`, () => updateBio(name, previous, chunkRows));
    const allFacts = parseFacts(previous);
    const facts = allFacts.filter((fact) => !fact.pii);
    const piiFacts = allFacts.filter((fact) => fact.pii);
    const current = new Map(facts.map((fact) => [normalize(fact.text), fact]));

    console.log(`\n================ ОБНОВЛЕНИЕ ${step}/${chunks.length} (сообщ. ${step * BIO_EVERY}) ================`);
    for (const fact of facts) {
      const before = prevFacts.get(normalize(fact.text));
      let state: string;
      if (!before) {
        state = fact.marker === 'уход' ? 'мимо' : 'НОВЫЙ';
      } else if (before.marker !== 'ядро' && fact.marker === 'ядро') {
        state = 'ЗАКРЕПЛЁН';
      } else if (fact.marker === 'ядро') {
        state = 'ядро';
      } else if (fact.marker === 'уход') {
        state = 'уход';
      } else {
        state = 'нов';
      }
      const tag = state === 'НОВЫЙ' ? '  +' : state === 'ЗАКРЕПЛЁН' ? ' ★' : state === 'мимо' ? ' ·' : '  ';
      console.log(`${tag} [${state}] ${fact.text}`);
    }
    const gone = [...prevFacts.values()].filter((fact) => !current.has(normalize(fact.text)));
    for (const fact of gone) {
      console.log(`  − [ВЫПАЛ] ${fact.text}`);
    }
    for (const fact of piiFacts) {
      console.log(`  ⚠ [PII ОТСЕЧЁН] ${fact.text}`);
    }

    prevFacts = current;
  }

  const core = parseFacts(previous).filter((fact) => fact.marker === 'ядро' && !fact.pii);
  console.log(`\n--- СТАБИЛЬНОЕ ЯДРО (${core.length} фактов) ---`);
  for (const fact of core) console.log(`  • ${fact.text}`);
}

async function main(): Promise<void> {
  const users = [...byUser().entries()]
    .filter(([, value]) => value.rows.length >= BIO_EVERY)
    .sort((a, b) => b[1].rows.length - a[1].rows.length)
    .slice(0, TOP);
  for (const [userId, { name, rows }] of users) {
    await evolve(userId, name, rows);
  }
}

void main();
