/**
 * Integration tests: run the full check suite against committed fixture
 * projects under test/fixtures/. These complement the per-check unit
 * tests by catching:
 *
 *   1. Cross-check interactions (rule A passes alone but fails when
 *      rule B's setup is in place).
 *   2. Public-API drift (`runChecks` / `runChecksFromFiles` result
 *      shape changes silently).
 *   3. Source-level parity between `fsFileSource` (CLI) and
 *      `mapFileSource` (agent) — same fixture must yield identical
 *      results across both.
 *   4. New checks that ship without being wired into `runChecksOn`
 *      (covered by the coverage guard at the bottom).
 *
 * Fixtures:
 *   - passing-app/   — minimal app that passes every fail-grade check
 *                      (bundle-size legitimately warns: no dist).
 *   - failing-app/   — rigged to trigger every fail/warn at once.
 *   - passing-game/  — game variant of passing-app (different brand
 *                      tokens, store domain, isGameProject=true).
 *
 * If a check name changes, this file fails loudly — that's the point.
 * Update intentionally; a passing snapshot diff means real semantics
 * shifted and downstream consumers (CLI, agent, CI workflows) need to
 * be aware.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as compliance from './index.js';
import { runChecks, runChecksFromFiles } from './index.js';
import type { CheckResult, CheckStatus } from './types.js';

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures');
const PASSING_APP = join(FIXTURES, 'passing-app');
const FAILING_APP = join(FIXTURES, 'failing-app');
const PASSING_GAME = join(FIXTURES, 'passing-game');

const summarise = (results: CheckResult[]): Record<CheckStatus, string[]> => ({
  pass: results.filter((r) => r.status === 'pass').map((r) => r.name),
  warn: results.filter((r) => r.status === 'warn').map((r) => r.name),
  fail: results.filter((r) => r.status === 'fail').map((r) => r.name),
});

describe('passing-app fixture', () => {
  it('has no fail results', async () => {
    const results = await runChecks(PASSING_APP);
    const fails = results.filter((r) => r.status === 'fail');
    expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
  });

  it('warns only on bundle-size (no dist built)', async () => {
    const results = await runChecks(PASSING_APP);
    expect(summarise(results).warn).toEqual(['Bundle size']);
  });
});

describe('failing-app fixture', () => {
  it('triggers the expected set of failures', async () => {
    const results = await runChecks(FAILING_APP);
    const summary = summarise(results);
    // Snapshot the *names* — tight contract that catches accidental
    // dropped or renamed checks. Detail/suggestion text is covered by
    // the snapshot test below.
    expect(summary.fail.sort()).toEqual([
      'Brand fonts present',
      'Brand tokens defined',
      'HTML meta tags',
      'MIT License',
      'No .env.production',
      'No brand overrides',
      'No template placeholders',
      'No tracking SDKs',
      'PWA manifest',
      'PWA offline correctness',
      'Viewport support',
    ]);
    expect(summary.warn.sort()).toEqual([
      'Bundle size',
      'CLAUDE.md is slim (no platform boilerplate)',
      'Dark mode support',
      'No unsafe 100vh',
      'PWA meta tags',
      'Store link',
    ]);
    // The only passing check on a maximally-broken app: no-scroll
    // skips because it's not a game project.
    expect(summary.pass).toEqual(['No scroll (games only)']);
  });
});

describe('failing-app snapshot', () => {
  /**
   * Stability gate: the full output shape (name + status + detail +
   * suggestions) is snapshotted for the failing fixture. If a check's
   * `detail` string or `suggestions` list changes, this test fails and
   * forces the author to acknowledge the format drift.
   *
   * Why specifically the failing fixture? It exercises every failure
   * branch and includes the most consumer-facing text — the strings
   * users actually see in `fas check` output, in agent chat replies,
   * and in CI annotations.
   *
   * To update: review the diff, run `pnpm exec vitest -u`.
   */
  it('matches snapshot for full result shape', async () => {
    const results = await runChecks(FAILING_APP);
    // Sort by name to keep the snapshot order stable across check
    // runs and reorderings of `runChecksOn`. Use byte-comparison
    // rather than localeCompare — locale defaults differ across CI
    // machines (e.g. `en-US.UTF-8` vs `C`) and can permute the sort.
    const sorted = [...results].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    expect(sorted).toMatchSnapshot();
  });
});

describe('passing-game fixture', () => {
  it('has no fail results', async () => {
    const results = await runChecks(PASSING_GAME);
    const fails = results.filter((r) => r.status === 'fail');
    expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
  });

  it('skips dark-mode for game projects (auto-pass with skipped detail)', async () => {
    const results = await runChecks(PASSING_GAME);
    const dark = results.find((r) => r.name === 'Dark mode support');
    expect(dark?.status).toBe('pass');
    expect(dark?.detail).toMatch(/skipped/);
  });

  it('uses --bg / --ink / --accent for game brand tokens (not --paper)', async () => {
    const results = await runChecks(PASSING_GAME);
    const tokens = results.find((r) => r.name === 'Brand tokens defined');
    expect(tokens?.status).toBe('pass');
    expect(tokens?.detail).toMatch(/--bg/);
  });
});

describe('FileSource parity (fs vs map)', () => {
  /**
   * Loading the same fixture both ways must produce the same check
   * results. This is the test that proves the SDK + agent stay aligned
   * even though they use different file-source implementations.
   */
  it.each([
    ['passing-app', PASSING_APP],
    ['failing-app', FAILING_APP],
    ['passing-game', PASSING_GAME],
  ])('runChecksFromFiles(%s) matches runChecks(%s)', async (_name, dir) => {
    const fromDisk = await runChecks(dir);
    const fromMap = await runChecksFromFiles(await readFixtureIntoMap(dir));
    expect(fromMap).toEqual(fromDisk);
  });
});

describe('coverage guard', () => {
  /**
   * Adding a new `check*` export and forgetting to wire it into
   * `runChecksOn` is a silent gap — the unit test passes, the CLI's
   * `fas check` doesn't run it, neither does the agent. This test
   * makes that mistake fail at CI time.
   */
  it('every exported check function is invoked by runChecksFromFiles', async () => {
    const checkExports = Object.entries(compliance)
      .filter(([k, v]) => /^check[A-Z]/.test(k) && typeof v === 'function')
      // Live-audit checks (`check*Live`) live in a separate runner;
      // exclude them from the source-side guard.
      .filter(([k]) => !k.endsWith('Live'))
      .map(([k]) => k);

    const results = await runChecksFromFiles(new Map());
    expect(results).toHaveLength(checkExports.length);
  });
});

/**
 * Walk a fixture directory into a Map<path, content> the same way the
 * agent's session DO would hold it. Mirrors fsFileSource semantics
 * (POSIX paths, skips noise dirs).
 */
async function readFixtureIntoMap(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const path of walk(dir, dir)) {
    out.set(path, await readFile(join(dir, path), 'utf8'));
  }
  return out;
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.wrangler',
  '.turbo',
]);

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, root);
    } else if (entry.isFile()) {
      yield relative(root, full).split(sep).join('/');
    }
  }
}
