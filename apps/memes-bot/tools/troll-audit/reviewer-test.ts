/**
 * Эксперимент: какой промпт-ревизор лучше согласуется со старшей моделью.
 *
 * Схема честная — сравниваются только рубрики:
 *   1) берутся реальные ответы бота из лога (то, что правда ушло в чат);
 *   2) каждый вариант ревизора оценивает ОДНИ И ТЕ ЖЕ ответы;
 *   3) старшая модель (deepseek-v4-pro) даёт свою оценку по LIVE_RUBRIC;
 *   4) считается, сколько раз ревизор забраковал ответ, который pro считает
 *      хорошим (зря переписывать), и сколько раз принял настоящий брак.
 *
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only -O '{"module":"commonjs"}' troll-audit/reviewer-test.ts /tmp/live.log [кейсов]
 *
 * Переключатели: AUDIT_CONCURRENCY (по умолчанию 2), AUDIT_QUIET=1, AUDIT_VERBOSE=1.
 */

import { writeFileSync } from 'node:fs';
import { judgeLive, parseLog } from './log-cases';
import { JUDGE_MODEL, call, pool, usage, withTag } from './llm';
import { REVIEWERS, THRESHOLD } from './reviewer-variants';
import { injectionLabels } from './injection-cases';
import { attachTrace, flat, hr, say, show } from './log';

/** Ответ считается хорошим у pro начиная с этой оценки. */
const PRO_GOOD = 0.8;
/** Ответ считается браком у pro ниже этой оценки. */
const PRO_BAD = 0.6;

interface VariantOutcome {
  score: number;
  issues: string[];
  calls: number;
}

interface Row {
  time: string;
  sent: string;
  pro: number;
  proMismatch: boolean;
  proVerdict: string;
  variants: Record<string, VariantOutcome>;
}

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

async function judgeOne(item: {
  time: string;
  payload: string;
  sent: string;
}): Promise<{ pro: number; mismatch: boolean; verdict: string }> {
  const verdict = await judgeLive(call, JUDGE_MODEL, item.payload, item.sent);
  return { pro: verdict.score, mismatch: verdict.addresseeMismatch, verdict: verdict.verdict };
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? '/tmp/live.log';
  const limit = Number(process.argv[3] ?? 12);
  const concurrency = Math.max(1, Number(process.env.AUDIT_CONCURRENCY ?? 2));

  const all = parseLog(path);
  // REVIEWER_FILTER=injection — только кейсы, где у бота пытались сломать роль.
  const onlyInjections = process.env.REVIEWER_FILTER === 'injection';
  const candidates = onlyInjections
    ? all.filter((item) => injectionLabels(item.payload).length > 0)
    : all;
  const cases = candidates.slice(-limit);

  attachTrace();

  process.stdout.write(
    `Эксперимент с ревизором: ${cases.length} реальных ответов${
      onlyInjections ? ` (только с попытками сломать роль, всего таких ${candidates.length})` : ''
    }, ${REVIEWERS.length} вариантов, параллельно ${concurrency}\n` +
      `Порог самопроверки ${THRESHOLD}; pro считает хорошим от ${PRO_GOOD}, браком ниже ${PRO_BAD}\n` +
      'Варианты: ' +
      REVIEWERS.map((reviewer) => `${reviewer.id} (${reviewer.title})`).join('; ') +
      '\n\n'
  );

  const tokensBefore = snapshot();

  const rows = await pool(cases, concurrency, (item) =>
    withTag(item.time, async () => {
      const labels = injectionLabels(item.payload);
      hr(`кейс ${item.time}${labels.length ? ` · попытка сломать роль: ${labels.join(', ')}` : ''}`);
      show(item.time, 'бот', item.sent, 400);
      const judged = await judgeOne(item);
      say(
        item.time,
        `резолюция судьи pro: ${judged.pro.toFixed(2)}${
          judged.mismatch ? ' [ПУТАНИЦА АДРЕСАТА]' : ''
        } — ${judged.verdict}`
      );

      const variants: Record<string, VariantOutcome> = {};
      for (const reviewer of REVIEWERS) {
        const outcome = await reviewer.run(item.payload, item.sent);
        variants[reviewer.id] = outcome;
        say(
          item.time,
          `резолюция ${reviewer.id}: ${outcome.score.toFixed(2)}${
            outcome.issues.length ? ` — ${flat(outcome.issues.join('; '), 220)}` : ' — замечаний нет'
          }`
        );
      }

      const row: Row = {
        time: item.time,
        sent: item.sent,
        pro: judged.pro,
        proMismatch: judged.mismatch,
        proVerdict: judged.verdict,
        variants,
      };
      return row;
    })
  );

  const tokensAll = diff(tokensBefore, snapshot());
  const rowsForPro = rows.filter((row) => !row.proMismatch);

  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  process.stdout.write(`\n${'='.repeat(96)}\nСравнение вариантов против оценки pro:\n`);
  process.stdout.write(
    'вариант'.padEnd(16) +
      'средн.'.padStart(8) +
      'MAE'.padStart(8) +
      'отклон.'.padStart(10) +
      'зря'.padStart(8) +
      'пропустил'.padStart(12) +
      'вызовов'.padStart(10) +
      '\n'
  );

  for (const reviewer of REVIEWERS) {
    const outcomes = rows.map((row) => row.variants[reviewer.id]);
    const scores = outcomes.map((outcome) => outcome.score);
    const rejected = outcomes.filter((outcome) => outcome.score < THRESHOLD).length;
    const falseReject = rows.filter(
      (row) => row.variants[reviewer.id].score < THRESHOLD && row.pro >= PRO_GOOD
    ).length;
    const missed = rows.filter(
      (row) => row.variants[reviewer.id].score >= THRESHOLD && row.pro < PRO_BAD
    ).length;
    const mae = mean(rows.map((row) => Math.abs(row.variants[reviewer.id].score - row.pro)));
    const calls = mean(outcomes.map((outcome) => outcome.calls));

    process.stdout.write(
      reviewer.id.padEnd(16) +
        mean(scores).toFixed(2).padStart(8) +
        mae.toFixed(2).padStart(8) +
        `${rejected}/${rows.length}`.padStart(10) +
        `${falseReject}`.padStart(8) +
        `${missed}`.padStart(12) +
        calls.toFixed(2).padStart(10) +
        '\n'
    );
  }

  process.stdout.write(
    `\n«отклон.» — столько ответов ревизор забраковал (score < ${THRESHOLD}) и отправил на переписывание;\n` +
      `«зря»      — из них те, что pro считает хорошими (>= ${PRO_GOOD}), то есть переписывать было не нужно;\n` +
      '«пропустил» — принял ответ, который pro считает браком.\n'
  );

  const worstForBaseline = rows
    .map((row) => ({ row, outcome: row.variants[REVIEWERS[0].id] }))
    .filter(({ outcome }) => outcome.score < THRESHOLD)
    .sort((a, b) => a.outcome.score - b.outcome.score);

  process.stdout.write(`\n${'='.repeat(96)}\nГде базовый ревизор бракует — и что об этом думает pro:\n`);
  for (const { row, outcome } of worstForBaseline.slice(0, 8)) {
    process.stdout.write(`\n--- ${row.time} (ревизор ${outcome.score.toFixed(2)}, pro ${row.pro.toFixed(2)})\n`);
    process.stdout.write(`ответ: ${flat(row.sent, 300)}\n`);
    process.stdout.write(`вывод pro: ${row.proVerdict}\n`);
    for (const reviewer of REVIEWERS) {
      const variant = row.variants[reviewer.id];
      process.stdout.write(
        `  ${reviewer.id.padEnd(14)} ${variant.score.toFixed(2)}  ${flat(variant.issues.join('; '), 200) || '—'}\n`
      );
    }
  }

  const missedAll = rows.filter((row) => row.pro < THRESHOLD);
  if (missedAll.length) {
    process.stdout.write(`\n${'='.repeat(96)}\nОтветы, которые pro считает слабыми (проверка на пропуск брака):\n`);
    for (const row of missedAll) {
      process.stdout.write(`\n--- ${row.time} (pro ${row.pro.toFixed(2)})\n`);
      show(row.time, 'ответ', row.sent, 300);
      for (const reviewer of REVIEWERS) {
        process.stdout.write(
          `  ${reviewer.id.padEnd(14)} ${row.variants[reviewer.id].score.toFixed(2)}\n`
        );
      }
    }
  }

  process.stdout.write(
    `\n${'='.repeat(96)}\nТокены на ${rows.length} ответов (ревизоры + pro-судья):\n` +
      `  запросов ${tokensAll.calls}, вход ${tokensAll.prompt}, выход ${tokensAll.completion}\n` +
      `  в среднем на один ответ: вход ${Math.round(tokensAll.prompt / rows.length)}, выход ${Math.round(
        tokensAll.completion / rows.length
      )}\n`
  );

  process.stdout.write(`\nВсего pro-оценок: ${rowsForPro.length}, средняя ${mean(rows.map((row) => row.pro)).toFixed(2)}\n`);

  const reportPath = '/tmp/reviewer-test.json';
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        threshold: THRESHOLD,
        proGood: PRO_GOOD,
        proBad: PRO_BAD,
        reviewers: REVIEWERS.map((reviewer) => ({ id: reviewer.id, title: reviewer.title })),
        rows,
      },
      null,
      2
    ),
    'utf8'
  );
  process.stdout.write(`Отчёт: ${reportPath}\n`);
}

void main();
