import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type CheckResult, runChecks } from '@proappstore/compliance';
import { Command } from 'commander';

/**
 * Find the app's repo root by walking up from `start` looking for the
 * marker files every scaffolded app has at root. Returns `start` if no
 * marker is found (so `--dir` can still target an arbitrary directory).
 *
 * Why: `pnpm build` runs the prebuild hook with cwd=`web/`, but the
 * compliance checks expect to find `LICENSE`, `web/index.html`, etc.
 * relative to the repo root. Walking up makes `pas check` work from
 * either the root or a `web/` subdir without callers having to pass
 * `--dir ..`. Same fix as @freegamestore/cli and @progamestore/cli.
 */
function findAppRoot(start: string): string {
  let dir = resolve(start);
  while (dir !== '/') {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml')) || existsSync(resolve(dir, 'LICENSE'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

const isTTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
const c = (open: string) => (s: string) => (isTTY ? `\x1b[${open}m${s}\x1b[39m` : s);
const green = c('32');
const yellow = c('33');
const red = c('31');
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s);

const ICON: Record<CheckResult['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
};

const COLOR: Record<CheckResult['status'], (s: string) => string> = {
  pass: green,
  warn: yellow,
  fail: red,
};

/**
 * Render compliance results in the standard format. Same shape as the
 * FAS / FGS CLIs so devs see consistent output across stores.
 */
export function renderCheckResults(results: CheckResult[]): {
  failed: number;
  warned: number;
  passed: number;
} {
  let failed = 0;
  let warned = 0;
  let passed = 0;
  for (const r of results) {
    // r.status is always one of pass/warn/fail (CheckStatus union), so
    // the lookups are total — non-null assertion satisfies
    // noUncheckedIndexedAccess without runtime cost.
    const icon = COLOR[r.status]!(ICON[r.status]!);
    process.stdout.write(`${icon}  ${bold(r.name.padEnd(28))} ${dim(r.detail)}\n`);
    if (r.suggestions && r.suggestions.length > 0 && r.status !== 'pass') {
      for (const s of r.suggestions) {
        process.stdout.write(`     ${dim('→')} ${dim(s)}\n`);
      }
    }
    if (r.status === 'fail') failed++;
    else if (r.status === 'warn') warned++;
    else passed++;
  }

  process.stdout.write('\n');
  if (failed > 0) {
    process.stdout.write(red(`✗ ${failed} failed`));
  } else {
    process.stdout.write(green('✓ all hard checks passed'));
  }
  if (warned > 0) {
    process.stdout.write(yellow(`, ${warned} warning${warned === 1 ? '' : 's'}`));
  }
  process.stdout.write('\n');

  return { failed, warned, passed };
}

export const checkCommand = new Command('check')
  .description('Run ProAppStore compliance checks against the current directory.')
  .option('--dir <path>', 'Directory to check', process.cwd())
  .action(async (opts: { dir: string }) => {
    const root = findAppRoot(opts.dir);
    const results = await runChecks(root);
    const { failed } = renderCheckResults(results);
    if (failed > 0) process.exit(1);
  });
