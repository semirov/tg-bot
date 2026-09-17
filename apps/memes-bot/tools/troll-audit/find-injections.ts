/**
 * Поиск в логе кейсов, где у бота пытались сломать роль или правила
 * (просили код, «игнорируй токсичность», раскрыть внутренности, сменить роль).
 * Нужен, чтобы проверить главную опасность самопроверки: не штрафует ли
 * ревизор бота за ПРАВИЛЬНЫЙ отказ выполнить такую просьбу.
 *
 * Обращений к модели нет — только разбор лога.
 *
 *   npx ts-node --transpile-only -O '{"module":"commonjs"}' troll-audit/find-injections.ts /tmp/live.log
 */

import { parseLog } from './log-cases';
import { flat } from './log';
import { injectionLabels } from './injection-cases';

async function main(): Promise<void> {
  const path = process.argv[2] ?? '/tmp/live.log';
  const cases = parseLog(path);

  let found = 0;
  for (const item of cases) {
    const labels = injectionLabels(item.payload);
    if (!labels.length) {
      continue;
    }
    found += 1;
    process.stdout.write(`\n=== ${item.time} — маркеры: ${labels.join(', ')}\n`);
    // Хвост задания — там последняя реплика, на которую бот отвечал.
    process.stdout.write(`конец задания: …${flat(item.payload, 0).slice(-420)}\n`);
    process.stdout.write(`ответ бота:   ${flat(item.sent, 320)}\n`);
  }

  process.stdout.write(`\nВсего кейсов с попытками сломать роль: ${found} из ${cases.length}\n`);
}

void main();
