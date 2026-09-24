#!/usr/bin/env node
/**
 * Coverage gaps (#128): after `vitest run --coverage`, print where the untested
 * code is — the least-covered files in the areas that matter most (backend
 * routes and libraries, the data worker, the SDK) — so the number in CI points
 * at something. Writes the same table to the GitHub step summary when run in
 * Actions. Read-only: thresholds are enforced by Vitest itself.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const AREAS = [
  ['backend routes', /\/packages\/backend\/src\/routes\//],
  ['backend lib', /\/packages\/backend\/src\/lib\//],
  ['data worker', /\/packages\/data-worker\/src\//],
  ['sdk', /\/packages\/sdk\/src\//],
];
const MIN_LINES = 25; // a file this small is noise in a "least covered" list
const PER_AREA = 6;

let summary;
try {
  summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
} catch {
  console.error('coverage/coverage-summary.json not found — run `vitest run --coverage` first');
  process.exit(1);
}
const total = summary.total;
const pct = (m) => `${m.pct.toFixed(1)}%`;
const rel = (f) => f.slice(f.indexOf('/packages/') + 1);

const lines = [];
lines.push(`Coverage: lines ${pct(total.lines)} · statements ${pct(total.statements)} · functions ${pct(total.functions)} · branches ${pct(total.branches)}`);
lines.push('');
for (const [name, re] of AREAS) {
  const files = Object.entries(summary)
    .filter(([f]) => f !== 'total' && re.test(f))
    .map(([f, v]) => ({ f: rel(f), lines: v.lines, branches: v.branches, functions: v.functions }));
  if (files.length === 0) continue;
  const agg = (m) => {
    const c = files.reduce((s, x) => s + x[m].covered, 0), t = files.reduce((s, x) => s + x[m].total, 0);
    return t ? `${((100 * c) / t).toFixed(1)}%` : 'n/a';
  };
  lines.push(`## ${name} — lines ${agg('lines')}, branches ${agg('branches')}, functions ${agg('functions')} (${files.length} files)`);
  lines.push('');
  lines.push('| least covered | lines | branches | functions |');
  lines.push('|---|---|---|---|');
  files
    .filter((x) => x.lines.total >= MIN_LINES)
    .sort((a, b) => a.lines.pct - b.lines.pct)
    .slice(0, PER_AREA)
    .forEach((x) => lines.push(`| \`${x.f}\` | ${pct(x.lines)} (${x.lines.covered}/${x.lines.total}) | ${pct(x.branches)} | ${pct(x.functions)} |`));
  lines.push('');
}
const out = lines.join('\n');
console.log('\n' + out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Test coverage\n\n${out}\n`);
