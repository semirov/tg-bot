/**
 * Прогонщик аудита промптов.
 *
 *   npx ts-node --transpile-only -O '{"module":"commonjs"}' troll-audit/run.ts
 *
 * Генерация — deepseek-flash (рабочая модель), оценка — deepseek-v4-pro.
 * Список наборов можно сузить: AUDIT_SUITES=dialog,security
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditCase, CASES, chatStyleChecks, chatTextChecks, matCheck } from './suites';
import { GEN_EFFORT, GEN_MODEL, JUDGE_EFFORT, JUDGE_MODEL, pool, usage, withTag } from './llm';
import { judge } from './harness';
import { attachTrace, hr, say, show } from './log';

interface CaseReport {
  id: string;
  suite: string;
  prompt: string;
  note: string;
  generated: string;
  codeIssues: string[];
  judgePass: boolean | null;
  judgeScore: number | null;
  judgeVerdict?: string;
  judgeIssues: string[];
  pass: boolean;
}

function universalChecks(testCase: AuditCase, output: string): string[] {
  if (testCase.kind === 'chat') {
    // Мат обязателен во всех ответах в чат (см. MAT_RULES в промптах).
    return [...chatTextChecks(output), ...chatStyleChecks(output), ...matCheck(output)];
  }
  if (testCase.kind === 'styled') {
    return chatTextChecks(output);
  }
  return [];
}

async function runCase(testCase: AuditCase): Promise<CaseReport> {
  const samples = Math.max(1, testCase.samples ?? 1);
  const rawOutputs: string[] = [];

  hr(`кейс ${testCase.id}`);
  say(
    testCase.id,
    `промпт ${testCase.prompt}, проверка «${testCase.note}»` +
      (samples > 1 ? `, сэмплов ${samples}` : '')
  );

  for (let index = 0; index < samples; index += 1) {
    let raw = '';
    try {
      raw = testCase.generateSample ? await testCase.generateSample(index) : await testCase.generate();
    } catch (error) {
      raw = `__GENERATION_ERROR__: ${error instanceof Error ? error.message : String(error)}`;
    }
    rawOutputs.push(raw);
  }

  const finalized = rawOutputs.map((raw) => (testCase.finalize ? testCase.finalize(raw) : raw));
  const joined = finalized.join('\n---\n');

  // Сырые генерации уже напечатала трассировка: здесь — только если постобработка что-то поменяла.
  if (joined !== rawOutputs.join('\n---\n')) {
    show(testCase.id, 'бот / после обработки', joined, 900);
  }

  const codeIssues: string[] = [];
  if (rawOutputs.some((raw) => raw.startsWith('__GENERATION_ERROR__'))) {
    codeIssues.push('ошибка генерации ответа модели');
  }
  for (const output of finalized) {
    codeIssues.push(...universalChecks(testCase, output));
  }
  if (testCase.checks) {
    codeIssues.push(...testCase.checks(joined));
  }
  for (const issue of codeIssues) {
    say(testCase.id, `проверка кода: ${issue}`);
  }

  let judgePass: boolean | null = null;
  let judgeScore: number | null = null;
  let judgeVerdict: string | undefined;
  let judgeIssues: string[] = [];

  if (testCase.criterion && !testCase.skipJudge) {
    try {
      const result = await judge(testCase.criterion, joined, testCase.context ?? '');
      judgePass = result.pass;
      judgeScore = result.score;
      judgeVerdict = result.verdict;
      judgeIssues = result.issues;
      say(
        testCase.id,
        `резолюция судьи: ${result.pass ? 'pass' : 'fail'}, score ${result.score}${
          result.verdict ? ` — ${result.verdict}` : ''
        }`
      );
      for (const issue of result.issues) {
        say(testCase.id, `  судья: ${issue}`);
      }
    } catch (error) {
      judgePass = false;
      judgeIssues = [`ошибка судьи: ${error instanceof Error ? error.message : String(error)}`];
      say(testCase.id, `резолюция судьи: ошибка — ${judgeIssues[0]}`);
    }
  }

  const pass = codeIssues.length === 0 && judgePass !== false;

  return {
    id: testCase.id,
    suite: testCase.suite,
    prompt: testCase.prompt,
    note: testCase.note,
    generated: joined,
    codeIssues,
    judgePass,
    judgeScore,
    judgeVerdict,
    judgeIssues,
    pass,
  };
}

function shorten(text: string, limit = 500): string {
  const flat = text.replace(/\n/g, ' ⏎ ');
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function main(): Promise<void> {
  const suiteFilter = process.env.AUDIT_SUITES;
  const cases = suiteFilter
    ? CASES.filter((testCase) => suiteFilter.split(',').includes(testCase.suite))
    : CASES;
  const concurrency = Math.max(1, Number(process.env.AUDIT_CONCURRENCY ?? 3));

  attachTrace();

  process.stdout.write(
    `Аудит промптов: ${cases.length} проверок, параллельно ${concurrency}` +
      ' (AUDIT_CONCURRENCY, AUDIT_QUIET=1 — сводка без живых логов, AUDIT_VERBOSE=1 — с промптами)\n' +
      `  генерация: ${GEN_MODEL} (reasoning_effort=${GEN_EFFORT || 'по умолчанию'})\n` +
      `  оценка:    ${JUDGE_MODEL} (reasoning_effort=${JUDGE_EFFORT || 'по умолчанию'})\n\n`
  );

  const reports = await pool(cases, concurrency, (testCase) =>
    withTag(testCase.id, async () => {
      const report = await runCase(testCase);
      process.stdout.write(`${report.pass ? '  PASS' : '  FAIL'}  ${report.id}\n`);
      return report;
    })
  );

  process.stdout.write('\n');

  for (const report of reports) {
    const mark = report.pass ? 'PASS' : 'FAIL';
    process.stdout.write(`${'='.repeat(78)}\n[${mark}] ${report.id}\n`);
    process.stdout.write(`  промпт: ${report.prompt}\n  проверка: ${report.note}\n`);
    process.stdout.write(`  ответ: ${shorten(report.generated)}\n`);
    if (report.judgeScore !== null) {
      process.stdout.write(
        `  судья: ${report.judgePass ? 'pass' : 'fail'} (score ${report.judgeScore})${
          report.judgeVerdict ? ` — ${report.judgeVerdict}` : ''
        }\n`
      );
    }
    for (const issue of report.codeIssues) {
      process.stdout.write(`  [код] ${issue}\n`);
    }
    for (const issue of report.judgeIssues) {
      process.stdout.write(`  [судья] ${issue}\n`);
    }
  }

  const failed = reports.filter((report) => !report.pass);
  const suites = [...new Set(reports.map((report) => report.suite))];

  process.stdout.write(`${'='.repeat(78)}\nИтог по наборам:\n`);
  for (const suite of suites) {
    const inSuite = reports.filter((report) => report.suite === suite);
    const ok = inSuite.filter((report) => report.pass).length;
    process.stdout.write(`  ${suite}: ${ok}/${inSuite.length}\n`);
  }

  const judged = reports.filter((report) => report.judgeScore !== null);
  const avgScore = judged.length
    ? judged.reduce((sum, report) => sum + (report.judgeScore ?? 0), 0) / judged.length
    : 0;

  process.stdout.write(
    `\nВсего: ${reports.length - failed.length}/${reports.length} прошло` +
      `, средняя оценка судьи ${avgScore.toFixed(2)}\n` +
      `Токены: запросов ${usage.calls}, prompt ${usage.promptTokens}, completion ${usage.completionTokens}` +
      `, из них reasoning ${usage.reasoningTokens}, пустых ответов ${usage.emptyAnswers}, ретраев ${usage.retries}\n`
  );

  const reportPath = join(__dirname, 'report.json');
  writeFileSync(reportPath, JSON.stringify(reports, null, 2), 'utf8');
  process.stdout.write(`Отчёт: ${reportPath}\n`);

  if (failed.length) {
    process.stdout.write(`\nПРОВАЛЕНО (${failed.length}):\n`);
    for (const report of failed) {
      process.stdout.write(`  - ${report.id}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
