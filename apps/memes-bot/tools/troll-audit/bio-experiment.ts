/**
 * Эксперимент «биографии участников» (per-chat долгая память тролля).
 *
 * Оффлайн-прогон на РЕАЛЬНОЙ истории чата mems:
 *  1) генерирует био каждого участника инкрементально, чанками по 10 реплик
 *     (как это будет работать в проде: каждые 10 сообщений — обновление);
 *  2) воспроизводит пару реальных обращений к боту и генерирует ответ
 *     С био и БЕЗ био — чтобы увидеть эффект.
 *
 * Промпты и санитайзеры берутся из настоящего модуля troll.
 *
 * Данные: /tmp/opencode/mems-history.json (дамп troll_message_entity чата mems).
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-experiment.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  CONVERSATION_PAUSE_RULE,
  JERK_PROMPT,
  MESSAGE_REFS_RULE,
} from '../../src/app/modules/troll/constants/troll-prompts';
import { wrapUserContent, sanitizeModelText } from '../../src/app/modules/troll/utils/troll-sanitizer';
import {
  buildConversationContext,
  formatConversationPause,
} from '../../src/app/modules/troll/utils/troll-context';
import { call, withTag } from './llm';

const HISTORY_FILE = process.env.BIO_HISTORY || '/tmp/opencode/mems-history.json';
const OUT_FILE = process.env.BIO_OUT || '/tmp/opencode/bio-experiment.json';

/** Сколько реплик копим до обновления био (как в проде). */
const BIO_EVERY = 10;
const BIO_MAX_CHARS = 1000;
const BIO_MAX_TOKENS = 700;

/** Промпт досье (прототип будущего MEMBER_BIO_PROMPT). */
const MEMBER_BIO_PROMPT = `Ты ведёшь краткое нейтральное досье на участника Telegram-чата. Из его реплик собери биографию: кто это, чем занимается, интересы, технический стек, привычки, повторяющиеся темы, устойчивые сведения о нём (работа, город, техника, увлечения) и манера общения.

Границы досье:
- Досье — только на САМОГО участника. О других людях можно упомянуть обобщённо («обсуждает чужие данные», «интересуется недвижимостью знакомых»), но НЕ заводи на них карточку.
- КАТЕГОРИЧЕСКИ НЕ сохраняй персональные данные — ни участника, ни третьих лиц: адреса и номера квартир, госномера, паспортные данные, СНИЛС, ИНН, номера телефонов, точные даты рождения, ФИО посторонних. Это запрещено, даже если человек сам это писал.
- Пиши только то, что уверенно следует из реплик. Ничего не выдумывай.
- Не приписывай человеку чужие слова и не путай его с другими участниками.
- Никаких оценок, оскорблений и мата: это досье, а не подкол.

Оформление:
- Телеграфный стиль, каждый факт с новой строки, без вступлений, заголовков и имени участника.
- Если дана прежняя биография — вплавь новые факты в неё, сохрани старое, убери дубли.
- Максимум ${BIO_MAX_CHARS} символов. Фактов больше — оставь самые важные и устойчивые.
- Ответ — только текст биографии.`;

/** Служебный блок с био, который подмешивается в диалоговый промпт. */
const BIO_INJECTION_HEADER = `Фон-досье (долгая память о собеседниках, факты из прошлых бесед). Используй уместно и ненавязчиво — как будто ты просто помнишь этих людей. НЕ цитируй досье дословно, НЕ перечисляй факты списком и НЕ показывай, что ведёшь записи. НЕ приписывай одному человеку факты другого и НЕ раскрывай никакие персональные данные (адреса, госномера, документы, телефоны) — их в досье нет, и выдумывать их нельзя.`;

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

const history: Row[] = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')).map((row: Row) => ({
  ...row,
  userId: row.userId === null ? null : Number(row.userId),
}));

const userRows = history.filter((row) => row.role === 'user' && row.userId !== null);

function byUser(): Map<number, { name: string; rows: Row[] }> {
  const map = new Map<number, { name: string; rows: Row[] }>();
  for (const row of userRows) {
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

/** Одна реплика участника — как её видит био-промпт. */
function renderMessages(rows: Row[]): string {
  return rows
    .map((row, index) => `${index + 1}) ${(row.content ?? '').replace(/\s*\n+\s*/g, ' ⏎ ').trim()}`)
    .join('\n');
}

async function generateBio(name: string, previous: string, chunkRows: Row[]): Promise<string> {
  const user = [
    `Участник: ${name}`,
    `Прежняя биография (может быть пустой):`,
    previous || '—',
    '',
    `Новые реплики участника:`,
    renderMessages(chunkRows),
  ].join('\n');

  const raw = await call(
    [
      { role: 'system', content: MEMBER_BIO_PROMPT },
      { role: 'user', content: wrapUserContent(user) },
    ],
    { temperature: 0.3, maxTokens: BIO_MAX_TOKENS, reasoningEffort: 'none', label: `био ${name}` }
  );
  return sanitizeModelText(raw ?? '', BIO_MAX_CHARS);
}

async function buildBios(): Promise<Map<number, { name: string; bio: string; steps: string[] }>> {
  const result = new Map<number, { name: string; bio: string; steps: string[] }>();
  const users = [...byUser().entries()].sort((a, b) => b[1].rows.length - a[1].rows.length);

  for (const [userId, { name, rows }] of users) {
    if (rows.length < BIO_EVERY) {
      console.log(`\n### ${name} — ${rows.length} сообщ. (< ${BIO_EVERY}, био ещё не заводится)`);
      result.set(userId, { name, bio: '', steps: [] });
      continue;
    }
    const chunks = chunk(rows, BIO_EVERY);
    let bio = '';
    const steps: string[] = [];
    console.log(`\n########## ${name} — ${rows.length} сообщ., ${chunks.length} обновлений ##########`);
    for (let i = 0; i < chunks.length; i += 1) {
      await withTag(`bio ${name}`, async () => {
        bio = await generateBio(name, bio, chunks[i]);
      });
      steps.push(bio);
      console.log(`\n----- ${name}: обновление ${i + 1}/${chunks.length} (сообщ. ${(i + 1) * BIO_EVERY}) -----`);
      console.log(bio);
    }
    result.set(userId, { name, bio, steps });
  }
  return result;
}

/** Расшифровка окна беседы — как в TrollService.formatTranscript(). */
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
      const label = row.userId !== null ? `${name} (${row.userId})` : name;
      return `${label}${ids}: ${row.content}`;
    })
    .join('\n');
}

function directiveFor(focus?: { userId: number; userName: string }): string {
  const label = focus ? `${focus.userName} (${focus.userId})` : '';
  if (label) {
    return `Отвечай участнику «${label}» — он к тебе обратился, id в ответ не пиши. По имени обращайся НЕ всегда: обычно просто отвечай по сути, а имя используй изредка (и тогда с большой буквы). В истории у каждого автора в скобках указан его id: если имена совпадают, различай собеседников по id и не приписывай одному чужие реплики. ${MESSAGE_REFS_RULE} ${CONVERSATION_PAUSE_RULE}`;
  }
  return `В истории у каждого автора в скобках указан его id — не путай собеседников и не приписывай одному участнику слова другого. ${MESSAGE_REFS_RULE} ${CONVERSATION_PAUSE_RULE}`;
}

function bioBlock(
  bios: Map<number, { name: string; bio: string }>,
  userIds: number[]
): string {
  const lines: string[] = [];
  const seen = new Set<number>();
  let used = 0;
  for (const id of userIds) {
    if (seen.has(id) || !bios.get(id)?.bio) continue;
    seen.add(id);
    const line = `${bios.get(id)!.name} (${id}): ${bios.get(id)!.bio}`;
    if (lines.length >= 5 || (used > 0 && used + line.length > 1800)) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return `${BIO_INJECTION_HEADER}\n${lines.join('\n')}`;
}

interface ResponseCase {
  title: string;
  targetMessageId: number;
  /** Сколько последних реплик контекста оставить (undefined — всё окно). */
  trim?: number;
}

async function reproduce(
  testCase: ResponseCase,
  bios: Map<number, { name: string; bio: string }>
): Promise<void> {
  const targetIndex = history.findIndex((row) => row.messageId === testCase.targetMessageId);
  if (targetIndex < 0) {
    console.log(`\n!!! кейс «${testCase.title}»: сообщение ${testCase.targetMessageId} не найдено`);
    return;
  }
  const target = history[targetIndex];
  const focus = { userId: Number(target.userId), userName: target.userName ?? 'участник' };

  // Всё до целевого сообщения включительно, от свежих к старым.
  let contextRows = history.slice(0, targetIndex + 1).reverse();
  if (testCase.trim) contextRows = contextRows.slice(0, testCase.trim);
  const transcript = buildTranscript(contextRows);

  // Участники окна (кроме бота) + адресат.
  const participants = new Set<number>([focus.userId]);
  for (const row of contextRows) {
    if (row.role === 'user' && row.userId !== null) participants.add(Number(row.userId));
  }
  const block = bioBlock(bios, [...participants]);

  const baseUser = `${wrapUserContent(transcript)}\n\n${directiveFor(focus)}`;
  const withBioUser = block ? `${block}\n\n${baseUser}` : baseUser;

  const label = testCase.trim ? `обрезка ${testCase.trim}` : 'полный контекст';
  console.log(`\n\n==================== КЕЙС: ${testCase.title} [${label}] ====================`);
  console.log(`Адресат: ${focus.userName} (${focus.userId})`);
  console.log(`Сообщение: ${target.content}`);
  console.log(`Реплик в контексте: ${contextRows.length}`);
  if (block) {
    console.log(`\n--- ФОН-ДОСЬЕ В ПРОМПТЕ ---\n${block}`);
  } else {
    console.log('\n--- ФОН-ДОСЬЕ: пусто ---');
  }

  const run = async (user: string, tag: string): Promise<string> =>
    withTag(tag, () =>
      call(
        [
          { role: 'system', content: JERK_PROMPT },
          { role: 'user', content: user },
        ],
        { temperature: 1.05, maxTokens: 300, reasoningEffort: 'none', label: tag }
      )
    ).then((raw) => sanitizeModelText(raw ?? '', 400).toLowerCase());

  const without = await run(baseUser, `без био · ${testCase.title}`);
  const withB = await run(withBioUser, `с био · ${testCase.title}`);

  console.log(`\n[B] БЕЗ БИО:\n${without}`);
  console.log(`\n[C] С БИО:\n${withB}`);
}

async function main(): Promise<void> {
  console.log('=== ЭТАП 1: генерация биографий (инкрементально, каждые 10 реплик) ===');
  const bios = await buildBios();

  console.log('\n\n=== ЭТАП 2: воспроизведение ответов (с био / без био) ===');
  const cases: ResponseCase[] = [
    { title: 'Константин: «скажи, я тревожник?»', targetMessageId: 21493 },
    { title: 'Артём: «ты обосрался, железка»', targetMessageId: 21466 },
    { title: 'Константин: «я тревожник?» (обрезанная память)', targetMessageId: 21493, trim: 4 },
  ];
  for (const testCase of cases) {
    await reproduce(testCase, bios);
  }

  const dump = {
    generatedAt: new Date().toISOString(),
    bios: [...bios.entries()].map(([userId, value]) => ({ userId, ...value })),
  };
  writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2));
  console.log(`\n\nБио сохранены в ${OUT_FILE}`);
}

void main();
