#!/usr/bin/env node
// Runs every runtime suite (one vitest config each) in sequence, each in its own process, and exits
// non-zero if any of them failed (#580).
//
// Why: the `test` script used to chain the configs with `&&`, so the first failing suite stopped the
// run and every suite after it went unreported. A failure in one Worker's suite now never hides the
// state of another's.
//
//   - Every suite runs, whatever the exit code of the one before it.
//   - Every vitest.*.ts config in this package must be listed below: an unlisted one fails the run
//     instead of quietly never running.
//   - The backend suite runs through scripts/run-backend-batches.mjs (#543), not vitest.backend.ts directly.
//
//   node scripts/run-all.mjs
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

const SUITES = [
  { name: 'config-drift', config: 'vitest.config-drift.ts' },
  { name: 'backend', config: 'vitest.backend.ts', args: ['scripts/run-backend-batches.mjs'] },
  { name: 'data-worker', config: 'vitest.data-worker.ts' },
  { name: 'agent-teams', config: 'vitest.agent-teams.ts' },
  { name: 'host', config: 'vitest.host.ts' },
  { name: 'admin', config: 'vitest.admin.ts' },
  { name: 'kb-host', config: 'vitest.kb-host.ts' },
  { name: 'mcp', config: 'vitest.mcp.ts' },
];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.on('error', () => resolve({ code: 1, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const configs = readdirSync(root).filter((f) => /^vitest\..+\.ts$/.test(f));
  const unlisted = configs.filter((c) => !SUITES.some((s) => s.config === c));
  if (unlisted.length) {
    console.error(`vitest config(s) not run by scripts/run-all.mjs: ${unlisted.join(', ')}. Add them to SUITES.`);
    return 1;
  }

  const results = [];
  for (const suite of SUITES) {
    console.log(`\n=== runtime suite ${suite.name} ===`);
    results.push({ suite, ...(await run(suite.args ?? [vitest, 'run', '--config', suite.config])) });
  }

  console.log('\n=== runtime suites ===');
  for (const r of results) {
    const how = r.code === 0 ? 'passed' : `failed (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ''})`;
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.suite.name.padEnd(12)} ${how}`);
  }
  const bad = results.filter((r) => r.code !== 0);
  if (bad.length) {
    console.error(`\n${bad.length} of ${results.length} runtime suites failed: ${bad.map((r) => r.suite.name).join(', ')}`);
    return 1;
  }
  return 0;
}

process.exit(await main());
