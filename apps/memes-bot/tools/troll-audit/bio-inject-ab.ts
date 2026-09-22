/**
 * A/B схем впрыска био в диалоговый промпт.
 *
 * Сравниваем, как расположение досье влияет на то, использует ли модель
 * долгую память в ответе:
 *  - top    — блок досье в начале пользовательского сообщения;
 *  - system — досье дописано в системный промпт;
 *  - tail   — досье в конце, с прямой инструкцией обыграть уместный факт;
 *  - none   — без био (базовая линия).
 *
 * Запуск:
 *   DEEPSEEK_API_KEY=... npx ts-node --transpile-only \
 *     -O '{"module":"commonjs"}' apps/memes-bot/tools/troll-audit/bio-inject-ab.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CacheEntry, InjectionVariant, bioFor, buildCases, generate, judge, rankFacts } from './bio-effect';

const CACHE_FILE = process.env.BIO_TUNING_CACHE || '/tmp/opencode/bio-tuning-cache.json';
const OUT_FILE = process.env.BIO_INJECT_OUT || '/tmp/opencode/bio-inject-ab.json';
const BUDGET = Number(process.env.BIO_INJECT_BUDGET || 800);
const SAMPLES = Number(process.env.BIO_INJECT_SAMPLES || 2);

async function main(): Promise<void> {
  const cache: CacheEntry[] = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  const cases = buildCases();
  const configs: Array<{ label: string; variant: InjectionVariant | 'none' }> = [
    { label: 'none', variant: 'none' },
    { label: 'top', variant: 'top' },
    { label: 'system', variant: 'system' },
    { label: 'tail', variant: 'tail' },
  ];

  const agg = new Map<string, { personalization: number; quality: number; used: number; invented: number; n: number }>();
  const details: unknown[] = [];

  for (const testCase of cases) {
    const entry = cache.find((item) => item.userId === testCase.focus.userId);
    const facts = entry ? rankFacts(entry) : [];
    const bio = bioFor(facts, BUDGET);
    for (const config of configs) {
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const variant: InjectionVariant = config.variant === 'none' ? 'top' : config.variant;
        const answer = await generate(testCase, config.variant === 'none' ? '' : bio, variant);
        const verdict = await judge(bio, testCase, answer);
        const acc = agg.get(config.label) ?? { personalization: 0, quality: 0, used: 0, invented: 0, n: 0 };
        acc.personalization += verdict.personalization;
        acc.quality += verdict.quality;
        acc.used += verdict.used_bio ? 1 : 0;
        acc.invented += verdict.invented ? 1 : 0;
        acc.n += 1;
        agg.set(config.label, acc);
        details.push({ case: testCase.target.messageId, label: config.label, answer, ...verdict });
        console.log(`[${testCase.target.messageId}] ${config.label}: pers=${verdict.personalization.toFixed(2)} qual=${verdict.quality.toFixed(2)} used=${verdict.used_bio}`);
      }
    }
  }

  console.log('\n===== СХЕМЫ ВПРЫСКА (бюджет %d символов) =====', BUDGET);
  console.log('схема  | ср. персонализация | ср. качество | использовала био | выдумок');
  for (const config of configs) {
    const acc = agg.get(config.label)!;
    console.log(
      `${config.label.padEnd(6)} | ${(acc.personalization / acc.n).toFixed(2).padStart(18)} | ${(acc.quality / acc.n).toFixed(2).padStart(12)} | ${acc.used}/${acc.n} | ${acc.invented}`
    );
  }

  writeFileSync(OUT_FILE, JSON.stringify({ budget: BUDGET, summary: [...agg.entries()], details }, null, 2));
  console.log(`\nДетали: ${OUT_FILE}`);
}

void main();
