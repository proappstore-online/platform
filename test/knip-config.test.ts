import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * #451: knip keeps dead exports, unused files and unused dependencies from
 * returning. `pnpm knip` itself runs in CI (ci.yml) against the whole repo; these
 * tests pin what that gate depends on: the config's shape, its wiring into the
 * package script and the CI job, and — on a throwaway project — that knip really
 * does fail on the two regressions the issue names.
 */

const ROOT = resolve(__dirname, '..');
const KNIP_BIN = join(ROOT, 'node_modules/knip/bin/knip.js');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

interface KnipConfig {
  $schema?: string;
  workspaces?: Record<string, { entry?: string[]; project?: string[]; ignoreDependencies?: string[] }>;
  ignoreDependencies?: string[];
  ignoreBinaries?: string[];
  ignoreIssues?: Record<string, string[]>;
}
const config = JSON.parse(read('knip.json')) as KnipConfig;

describe('knip.json', () => {
  it('is wired to the knip schema and declares per-workspace entry points', () => {
    expect(config.$schema).toMatch(/knip@\d+\/schema\.json$/);
    expect(Object.keys(config.workspaces ?? {})).toEqual(expect.arrayContaining(['.', 'packages/*']));
  });

  it('only names workspaces that exist', () => {
    const packages = readdirSync(join(ROOT, 'packages')).filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory());
    for (const key of Object.keys(config.workspaces ?? {})) {
      if (key === 'packages/*') expect(packages.length).toBeGreaterThan(0);
      else expect(existsSync(join(ROOT, key, 'package.json')), key).toBe(true);
    }
  });

  it('only exempts files that exist', () => {
    for (const file of Object.keys(config.ignoreIssues ?? {})) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it('keeps templates, compliance fixtures and the sandbox stubs out of the analysed set', () => {
    const analysed = Object.values(config.workspaces ?? {}).flatMap((w) => w.project ?? []);
    for (const glob of analysed) {
      expect(glob, glob).not.toMatch(/^(templates|packages\/[^/]+\/templates|packages\/compliance\/test\/fixtures)\b/);
    }
  });

  it('counts a test file as a use of what it imports', () => {
    expect(config.workspaces?.['packages/*']?.entry).toContain('src/**/*.test.{ts,tsx}');
  });

  it('exempts only the published SDK aliases and the worker-limit aliases from the duplicates check', () => {
    expect(config.ignoreIssues).toEqual({
      'packages/sdk/src/hooks.ts': ['duplicates'],
      'packages/sdk/src/shell.tsx': ['duplicates'],
      'packages/backend/src/routes/app-workers.ts': ['duplicates'],
    });
  });
});

describe('the gate', () => {
  it('is a root script and a pinned dev dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts.knip).toMatch(/^knip\b/);
    expect(pkg.devDependencies.knip).toMatch(/^\^?\d+\./);
  });

  it('runs in the CI check job, before typecheck, and is listed in the verification bar', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/- name: Dead exports and unused dependencies\n\s+run: pnpm knip\n/);
    expect(ci.indexOf('run: pnpm knip')).toBeLessThan(ci.indexOf('run: pnpm -r typecheck'));
    expect(read('CLAUDE.md')).toMatch(/^pnpm knip\s/m);
  });
});

describe('what knip catches (throwaway project, same config shape)', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function project(files: Record<string, string>, dependencies: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'knip-fixture-'));
    dirs.push(dir);
    const all: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies }),
      'knip.json': JSON.stringify({ entry: ['src/index.ts', 'src/**/*.test.ts'], project: ['src/**/*.ts'] }),
      ...files,
    };
    for (const [name, body] of Object.entries(all)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return dir;
  }
  const runKnip = (cwd: string) => {
    const r = spawnSync(process.execPath, [KNIP_BIN, '--no-progress'], { cwd, encoding: 'utf8', timeout: 90_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('passes a project whose exports are all used', () => {
    const dir = project({
      'src/index.ts': "import { used } from './lib.js';\nexport const main = () => used();\n",
      'src/lib.ts': 'export const used = () => 1;\n',
    });
    expect(runKnip(dir)).toMatchObject({ code: 0 });
  });

  it('fails on a new unused export, naming it', () => {
    const dir = project({
      'src/index.ts': "import { used } from './lib.js';\nexport const main = () => used();\n",
      'src/lib.ts': 'export const used = () => 1;\nexport const deadExport = () => 2;\n',
    });
    const { code, out } = runKnip(dir);
    expect(code).toBe(1);
    expect(out).toContain('Unused exports');
    expect(out).toContain('deadExport');
  });

  it('counts an export used only by a test as used', () => {
    const dir = project({
      'src/index.ts': 'export const main = () => 1;\n',
      'src/helper.ts': 'export const forTests = () => 2;\n',
      'src/helper.test.ts': "import { forTests } from './helper.js';\nforTests();\n",
    });
    expect(runKnip(dir).code).toBe(0);
  });

  it('lets an export tagged @public stand, for code loaded by a computed import()', () => {
    const dir = project({
      'src/index.ts': "import { used } from './lib.js';\nexport const main = () => used();\n",
      'src/lib.ts': 'export const used = () => 1;\n/** Loaded by a test through a computed import(). @public */\nexport const loadedDynamically = () => 2;\n',
    });
    expect(runKnip(dir).code).toBe(0);
  });

  it('fails on an unused exported type', () => {
    const dir = project({
      'src/index.ts': "import { used } from './lib.js';\nexport const main = () => used();\n",
      'src/lib.ts': 'export const used = () => 1;\nexport type Dead = { a: number };\n',
    });
    const { code, out } = runKnip(dir);
    expect(code).toBe(1);
    expect(out).toContain('Dead');
  });

  it('fails on an unused file', () => {
    const dir = project({
      'src/index.ts': 'export const main = () => 1;\n',
      'src/orphan.ts': 'export const orphan = 1;\n',
    });
    const { code, out } = runKnip(dir);
    expect(code).toBe(1);
    expect(out).toContain('Unused files');
    expect(out).toContain('src/orphan.ts');
  });

  it('fails on an unused dependency', () => {
    const dir = project({ 'src/index.ts': 'export const main = () => 1;\n' }, { 'left-pad': '^1.3.0' });
    const { code, out } = runKnip(dir);
    expect(code).toBe(1);
    expect(out).toContain('Unused dependencies');
    expect(out).toContain('left-pad');
  });
});
