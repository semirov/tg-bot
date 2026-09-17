/**
 * Валидация механизма самопроверки на реальных ответах из логов.
 *
 * Схема эксперимента:
 *   1) контроль — одно чистое поколение ответа (как работает бот сейчас);
 *   2) механизм — генерация + ревизия + до 3 попыток с учётом замечаний.
 * Оба варианта оценивает старшая модель (deepseek-v4-pro), а расход токенов
 * на генерацию и ревизию считается по факту из ответов API.
 *
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only -O '{"module":"commonjs"}' troll-audit/selfcheck-test.ts /tmp/live.log [сколько_кейсов]
 */

import { writeFileSync } from 'node:fs';
import { JERK_PROMPT, SELF_CHECK_PROMPT, buildRetryNote } from '../../src/app/modules/troll/constants/troll-prompts';
import { parseLog, judgeLive, LiveCase } from './log-cases';
import { GEN_MODEL, JUDGE_MODEL, call, parseJson, pool, usage, withTag } from './llm';
import { postChat } from './harness';
import { attachTrace, flat, hr, say } from './log';

const MAX_ATTEMPTS = 3;
const THRESHOLD = 0.6;
const CONTEXT_CHARS = 2000;
const GEN_TOKENS = 300;
const GEN_TEMPERATURE = 1.05;

interface Snapshot {
  calls: number;
  prompt: number;
  completion: number;
}

function snapshot(): Snapshot {
  return { calls: usage.calls, prompt: usage.promptTokens, completion: usage.completionTokens };
}

function diff(before: Snapshot, after: Snapshot): Snapshot {
  return {
    calls: after.calls - before.calls,
    prompt: after.prompt - before.prompt,
    completion: after.completion - before.completion,
  };
}

/** Один ответ модели: то же задание, что уходило в модель в проде. */
async function generate(payload: string, label: string, retryNote = ''): Promise<string> {
  const raw = await call(
    [
      { role: 'system', content: JERK_PROMPT },
      { role: 'user', content: `${payload.replace(/ ⏎ /g, '\n')}${retryNote}` },
    ],
    { model: GEN_MODEL, maxTokens: GEN_TOKENS, temperature: GEN_TEMPERATURE, label }
  );
  return postChat(raw, 400);
}

/** Ревизия ответа: тот же промпт, что использует бот в самопроверке. */
async function review(payload: string, reply: string): Promise<{ score: number; issues: string[] }> {
  const flat = payload.replace(/ ⏎ /g, '\n');
  const tail = flat.length > CONTEXT_CHARS ? `…\n${flat.slice(-CONTEXT_CHARS)}` : flat;

  const raw = await call(
    [
      { role: 'system', content: SELF_CHECK_PROMPT },
      {
        role: 'user',
        content: `<user_message>\nПереписка (последние реплики):\n${tail}\n\nОтвет бота:\n${reply}\n</user_message>`,
      },
    ],
    { model: GEN_MODEL, temperature: 0, maxTokens: 600, json: true, kind: 'assess', label: 'ревизор' }
  );

  const parsed = parseJson<{ score?: number; issues?: unknown }>(raw);
  const score = Number(parsed?.score);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    issues: Array.isArray(parsed?.issues)
      ? (parsed!.issues as unknown[]).filter((i): i is string => typeof i === 'string')
      : [],
  };
}

interface CaseResult {
  time: string;
  control: string;
  controlScore: number;
  checked: string;
  checkedScore: number;
  attempts: number;
  reviews: number[];
  tokensControl: Snapshot;
  tokensChecked: Snapshot;
}

async function runCase(item: LiveCase): Promise<CaseResult> {
  hr(`кейс ${item.time}`);
  say(item.time, `вход ${item.payload.length} символов; контроль — одна генерация (как сейчас в проде)`);

  // Контроль: одно чистое поколение.
  const controlBefore = snapshot();
  const control = await generate(item.payload, 'бот / контроль');
  const tokensControl = diff(controlBefore, snapshot());

  // Механизм: генерация + ревизия + переписывания.
  say(item.time, `механизм: до ${MAX_ATTEMPTS} генераций + ревизия (порог ${THRESHOLD})`);
  const checkedBefore = snapshot();
  let attempts = 0;
  let reviews: number[] = [];
  let previous = '';
  let issues: string[] = [];
  let best = { text: '', score: -1, attempt: 0 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const note = attempt > 1 ? buildRetryNote(previous, issues, attempt) : '';
    if (attempt > 1) {
      say(item.time, `переписываю (попытка ${attempt}/${MAX_ATTEMPTS}) по замечаниям ревизора`);
    }
    const text = await generate(item.payload, `бот / попытка ${attempt}`, note);
    if (!text) {
      say(item.time, `попытка ${attempt}: модель вернула пусто, пропускаю`);
      continue;
    }

    const verdict = await review(item.payload, text);
    reviews.push(verdict.score);
    say(
      item.time,
      `резолюция ревизора по попытке ${attempt}: ${verdict.score.toFixed(2)}` +
        (verdict.score >= THRESHOLD ? ' — принимаю' : ' — брак') +
        (verdict.issues.length ? ` — ${flat(verdict.issues.join('; '), 400)}` : '')
    );

    if (verdict.score > best.score) {
      best = { text, score: verdict.score, attempt };
    }
    if (verdict.score >= THRESHOLD) {
      break;
    }
    previous = text;
    issues = verdict.issues;
  }

  const tokensChecked = diff(checkedBefore, snapshot());

  const finalText = best.text || control;
  say(
    item.time,
    `резолюция механизма: беру вариант попытки ${best.attempt} (${best.score.toFixed(2)}), ` +
      `переписываний ${Math.max(0, attempts - 1)}, ревизии ${reviews.join('/') || '—'}`
  );

  const verdictChecked = await judgeLive(call, JUDGE_MODEL, item.payload, finalText);
  const verdictControl = await judgeLive(call, JUDGE_MODEL, item.payload, control);
  say(
    item.time,
    `резолюция судьи pro: контроль ${verdictControl.score.toFixed(2)} → механизм ${verdictChecked.score.toFixed(2)}`
  );
  for (const issue of [...verdictControl.issues, ...verdictChecked.issues]) {
    say(item.time, `  судья: ${issue}`);
  }

  return {
    time: item.time,
    control,
    controlScore: verdictControl.score,
    checked: finalText,
    checkedScore: verdictChecked.score,
    attempts,
    reviews,
    tokensControl,
    tokensChecked,
  };
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? '/tmp/live.log';
  const limit = Number(process.argv[3] ?? 8);

  const all = parseLog(path);
  // Берём самые разные: без повторов одного и того же времени.
  const cases = all.slice(-limit);

  attachTrace();

  const concurrency = Math.max(1, Number(process.env.AUDIT_CONCURRENCY ?? 2));

  process.stdout.write(
    `Живых диалоговых ответов в логе: ${all.length}, беру последние ${cases.length}, параллельно ${concurrency}\n` +
      `Контроль: 1 генерация; механизм: до ${MAX_ATTEMPTS} генераций + ревизии (порог ${THRESHOLD})\n` +
      `Проверка обоих вариантов — старшей моделью ${JUDGE_MODEL}` +
      ' (AUDIT_CONCURRENCY=1 — строго по порядку, AUDIT_QUIET=1 — без живых логов)\n\n'
  );

  const results = await pool(cases, concurrency, (item) =>
    withTag(item.time, async () => {
      const result = await runCase(item);
      process.stdout.write(
        `  ${result.time}: было ${result.controlScore.toFixed(2)} → стало ${result.checkedScore.toFixed(2)}` +
          ` (попыток ${result.attempts}, ревизии ${result.reviews.join('/')})\n`
      );
      return result;
    })
  );

  const n = results.length;
  const sum = (pick: (r: CaseResult) => number) => results.reduce((total, r) => total + pick(r), 0);

  const controlAvg = sum((r) => r.controlScore) / n;
  const checkedAvg = sum((r) => r.checkedScore) / n;
  const improved = results.filter((r) => r.checkedScore > r.controlScore).length;
  const worsened = results.filter((r) => r.checkedScore < r.controlScore).length;
  const same = n - improved - worsened;
  const retried = results.filter((r) => r.attempts > 1).length;

  const controlPrompt = sum((r) => r.tokensControl.prompt);
  const controlCompletion = sum((r) => r.tokensControl.completion);
  const checkedPrompt = sum((r) => r.tokensChecked.prompt);
  const checkedCompletion = sum((r) => r.tokensChecked.completion);
  const controlCalls = sum((r) => r.tokensControl.calls);
  const checkedCalls = sum((r) => r.tokensChecked.calls);

  const pct = (after: number, before: number) => `${((after / before - 1) * 100).toFixed(0)}%`;

  process.stdout.write(`\n${'='.repeat(78)}\nКачество (оценка pro-модели):\n`);
  process.stdout.write(`  контроль (1 генерация): ${controlAvg.toFixed(2)}\n`);
  process.stdout.write(`  с самопроверкой:        ${checkedAvg.toFixed(2)}\n`);
  process.stdout.write(`  стало лучше: ${improved}, хуже: ${worsened}, без изменений: ${same}\n`);
  process.stdout.write(`  переписываний потребовалось: ${retried} из ${n}\n`);

  process.stdout.write(`\n${'='.repeat(78)}\nТокены на ${n} ответов (генерация + ревизия, без проверки pro):\n`);
  process.stdout.write(
    `  контроль:  ${controlCalls} запросов, вход ${controlPrompt}, выход ${controlCompletion}\n`
  );
  process.stdout.write(
    `  механизм:  ${checkedCalls} запросов, вход ${checkedPrompt} (+${pct(checkedPrompt, controlPrompt)}),` +
      ` выход ${checkedCompletion} (+${pct(checkedCompletion, controlCompletion)})\n`
  );
  process.stdout.write(
    `  в среднем на ответ: вход ${Math.round(controlPrompt / n)} → ${Math.round(
      checkedPrompt / n
    )}, выход ${Math.round(controlCompletion / n)} → ${Math.round(checkedCompletion / n)}\n`
  );

  process.stdout.write(`\n${'='.repeat(78)}\nПримеры:\n`);
  for (const result of results.slice(0, 4)) {
    process.stdout.write(`\n--- ${result.time} (${result.controlScore.toFixed(2)} → ${result.checkedScore.toFixed(2)})\n`);
    process.stdout.write(`было:  ${result.control.replace(/\n/g, ' ⏎ ')}\n`);
    process.stdout.write(`стало: ${result.checked.replace(/\n/g, ' ⏎ ')}\n`);
  }

  writeFileSync('/tmp/selfcheck-results.json', JSON.stringify(results, null, 2), 'utf8');
  process.stdout.write('\nПодробности: /tmp/selfcheck-results.json\n');
}

void main();
