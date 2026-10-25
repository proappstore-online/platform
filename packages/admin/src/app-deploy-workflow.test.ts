import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function tmp(pkg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/**
 * #435: the Build step's fail-closed gate (#204) must not depend on jq. On a runner without jq
 * `if jq -e ...` is false, so a bundle with a build script silently got a bare `vite build`.
 */
const WORKFLOW = readFileSync(new URL('../../../.github/workflows/app-deploy.yml', import.meta.url), 'utf8');

const step = (name: string): string => {
  const start = WORKFLOW.indexOf(`- name: ${name}\n`);
  expect(start, `step "${name}" exists`).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf('\n      - ', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
};

describe('app-deploy.yml Build gate (#435)', () => {
  it('decides gated vs fallback build with node, not jq', () => {
    const build = step('Build');
    expect(build).toContain(`node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"`);
    expect(build).not.toMatch(/\bjq\b.*scripts\.build/);
    expect(build).toContain('pnpm build');
    expect(build).toContain('npx vite build');
  });

  it('installs jq on self-hosted macOS before Build, failing loudly', () => {
    const ensure = step('Ensure jq on self-hosted macOS');
    expect(ensure).toContain("if: runner.os == 'macOS'");
    expect(ensure).toContain('brew install jq');
    expect(ensure).toContain('::error::');
    expect(WORKFLOW.indexOf('- name: Ensure jq on self-hosted macOS')).toBeLessThan(WORKFLOW.indexOf('- name: Build\n'));
  });

  it('the node gate really tells a build script from none', () => {
    const gate = (pkg: unknown) => {
      try { execFileSync('node', ['-e', "process.exit(require('./package.json').scripts?.build ? 0 : 1)"], { cwd: tmp(pkg) }); return 0; }
      catch (e) { return (e as { status: number }).status; }
    };
    expect(gate({ scripts: { build: 'tsc && vite build' } })).toBe(0);
    expect(gate({ scripts: { dev: 'vite' } })).toBe(1);
    expect(gate({})).toBe(1);
  });
});
