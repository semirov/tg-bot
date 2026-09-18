#!/usr/bin/env node
/**
 * Generates a git-visible coverage report from the Jest istanbul summary.
 *
 * Reads  : coverage/apps/memes-bot/coverage-summary.json  (git-ignored)
 * Writes : COVERAGE.md      (committed -> coverage is visible in the repo)
 *          coverage-badge.svg (committed -> badge for README/PR)
 *
 * Usage: npm run coverage:report   (after `npm run coverage`)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const summaryPath = path.join(root, 'coverage/apps/memes-bot/coverage-summary.json');
const reportPath = path.join(root, 'COVERAGE.md');
const badgePath = path.join(root, 'coverage-badge.svg');

if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary not found: ${summaryPath}`);
  console.error('Run the tests with coverage first: npm run coverage');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const total = summary.total;
const pct = (value) => `${value.toFixed(2)}%`;

const moduleOf = (absolutePath) => {
  const rel = absolutePath.replace(`${root}${path.sep}`, '').split(path.sep).join('/');
  const marker = '/src/app/modules/';
  if (rel.includes(marker)) return rel.split(marker)[1].split('/')[0];
  if (rel.includes('/src/app/')) return 'app';
  const afterSrc = rel.split('/src/')[1];
  return afterSrc ? afterSrc.split('/')[0] : rel;
};

const files = Object.entries(summary)
  .filter(([key]) => key !== 'total')
  .map(([key, value]) => ({ file: key, ...value }));

const modules = new Map();
for (const entry of files) {
  const name = moduleOf(entry.file);
  const acc = modules.get(name) || {
    name,
    files: 0,
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };
  acc.files += 1;
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    acc[metric].covered += entry[metric].covered;
    acc[metric].total += entry[metric].total;
  }
  modules.set(name, acc);
}

const metricPct = (m) => (m.total === 0 ? 100 : (m.covered / m.total) * 100);
const moduleRows = [...modules.values()].sort((a, b) => b.statements.total - a.statements.total);
const fileRows = [...files].sort(
  (a, b) => a.file.replace(`${root}${path.sep}`, '').localeCompare(b.file.replace(`${root}${path.sep}`, ''))
);

const badgeColor = (value) => {
  if (value >= 95) return '#4c1';
  if (value >= 90) return '#97ca00';
  if (value >= 80) return '#dfb317';
  if (value >= 70) return '#fe7d37';
  return '#e05d44';
};

const statementsPct = metricPct(total.statements);
const badgeLabel = 'coverage';
const badgeValue = `${statementsPct.toFixed(0)}%`;
const badgeWidth = 100;
const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="20" role="img" aria-label="${badgeLabel}: ${badgeValue}">
  <title>${badgeLabel}: ${badgeValue}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${badgeWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="62" height="20" fill="#555"/>
    <rect x="62" width="38" height="20" fill="${badgeColor(statementsPct)}"/>
    <rect width="${badgeWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="31" y="15" fill="#010101" fill-opacity=".3">${badgeLabel}</text>
    <text x="31" y="14">${badgeLabel}</text>
    <text x="81" y="15" fill="#010101" fill-opacity=".3">${badgeValue}</text>
    <text x="81" y="14">${badgeValue}</text>
  </g>
</svg>
`;

let commit = '';
try {
  const { execSync } = await import('node:child_process');
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {
  commit = 'unknown';
}

const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

const overallTable = [
  '| Metric | Covered | Total | % |',
  '| --- | ---: | ---: | ---: |',
  ...[
    ['Statements', total.statements],
    ['Branches', total.branches],
    ['Functions', total.functions],
    ['Lines', total.lines],
  ].map(([label, m]) => `| ${label} | ${m.covered} | ${m.total} | **${pct(m.pct)}** |`),
].join('\n');

const moduleTable = [
  '| Module | Files | Statements | Branches | Functions | Lines |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...moduleRows.map(
    (m) =>
      `| \`${m.name}\` | ${m.files} | ${metricPct(m.statements).toFixed(1)}% | ${metricPct(
        m.branches
      ).toFixed(1)}% | ${metricPct(m.functions).toFixed(1)}% | ${metricPct(m.lines).toFixed(1)}% |`
  ),
].join('\n');

const fileTable = [
  '| File | Statements | Branches | Functions | Lines |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...fileRows.map((f) => {
    const rel = f.file.replace(`${root}${path.sep}`, '').split(path.sep).join('/');
    return `| \`${rel}\` | ${f.statements.pct}% | ${f.branches.pct}% | ${f.functions.pct}% | ${f.lines.pct}% |`;
  }),
].join('\n');

const report = `<!-- generated by tools/coverage/generate-coverage-report.mjs — do not edit by hand -->
# Code coverage

![coverage](./coverage-badge.svg)

Generated: ${generatedAt} · commit \`${commit}\` · Jest + ts-jest

**Overall: ${pct(total.statements.pct)} statements · ${pct(total.branches.pct)} branches · ${pct(
  total.functions.pct
)} functions · ${pct(total.lines.pct)} lines** (threshold 95%).

${overallTable}

## By module

${moduleTable}

## By file

<details>
<summary>Full per-file breakdown (${files.length} files)</summary>

${fileTable}

</details>

## How to reproduce

\`\`\`bash
npm run coverage          # run tests and write coverage/apps/memes-bot
npm run coverage:report   # regenerate COVERAGE.md and coverage-badge.svg
\`\`\`

## Scope

Coverage is collected from \`apps/memes-bot/src/**/*.ts\`.
Excluded: \`*.spec.ts\` (tests), \`src/main.ts\` (process bootstrap), and \`*.module.ts\`
(NestJS dependency-injection wiring with no executable logic).

${files.length} source files · ${total.statements.total} statements · ${total.branches.total} branches · ${total.functions.total} functions · ${total.lines.total} lines.
`;

fs.writeFileSync(reportPath, report);
fs.writeFileSync(badgePath, badge);
console.log(`Wrote ${path.relative(root, reportPath)} and ${path.relative(root, badgePath)}`);
console.log(
  `Coverage: statements ${pct(total.statements.pct)}, branches ${pct(
    total.branches.pct
  )}, functions ${pct(total.functions.pct)}, lines ${pct(total.lines.pct)}`
);
