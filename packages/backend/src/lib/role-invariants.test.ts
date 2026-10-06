import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEAM_ROLES } from './auth.js';

// Guards for the three-role-system invariants (docs/authorization-model.md).
// PAS keeps three distinct role scopes on purpose; these tests stop the class of
// scope-confusion bugs (#78 data-worker, #79 agent-teams, #95 verifyAppOwnership)
// from silently regrowing.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('role-system invariants', () => {
  it('the TEAM_ROLES ladder is identical in every worker that vendors it (no rank drift)', () => {
    const canonical = JSON.stringify([...TEAM_ROLES]);
    const extract = (src: string): string => {
      const m = src.match(/TEAM_ROLES\s*=\s*\[([^\]]*)\]/);
      if (!m) throw new Error('TEAM_ROLES literal not found');
      const values = m[1]!
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      return JSON.stringify(values);
    };
    // Vendored copies (separate packages that depend on nothing at runtime).
    for (const rel of [
      '../../../data-worker/src/index.ts',
      '../../../agent-teams/src/role-gate.ts',
    ]) {
      expect(extract(read(rel)), rel).toBe(canonical);
    }
  });

  it('no worker gates app access on membership alone — the #78/#79/#95 anti-pattern', () => {
    // `(apps).some(a => a.id === appId)` returned an authz decision WITHOUT
    // checking team_role. Every such site must instead read `team_role` (or call
    // requireAppAccess). Assert the raw pattern is absent from every self-authz
    // worker/helper.
    const antiPattern = /\.some\(\(?\w+\)?\s*=>\s*\w+\.id === appId\)/;
    for (const rel of [
      '../../../data-worker/src/index.ts',
      '../../../agent-teams/src/project-do.ts',
      '../../../agent-teams/src/index.ts',
      '../../../build-core/src/ownership.ts',
      '../../../mcp/src/project-tools.ts',
    ]) {
      expect(antiPattern.test(read(rel)), `${rel} must not gate on membership alone`).toBe(false);
    }
  });
});

// #254: an app worker acts as `system:worker`, which must never satisfy a role
// gate — not even if someone granted that id an app role. Its path refuses a
// role-gated action outright. #260: the only path that runs a role check is a
// verified caller grant, and it checks the grant's user, never system:worker.
describe('system:worker holds no role (#254, #260)', () => {
  it('without a grant, a role-gated action is refused before any role check', () => {
    const src = read('./app-worker-calls.ts');
    const workerBranch = /\} else \{\s*if \(!actionCallers\(manifest\)\.includes\('worker'\)\)[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
    expect(workerBranch).toMatch(/app_roles\?\.length \|\| manifest\.auth\?\.platform_roles\?\.length\) \{\s*throw new WorkerCallError\('Forbidden'/);
    expect(workerBranch).not.toMatch(/enforceActionAuth/);
  });

  it('the role check runs only inside the caller-grant branch, as the grant\'s user', () => {
    const src = read('./app-worker-calls.ts');
    const calls = [...src.matchAll(/enforceActionAuth\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(calls).toEqual([expect.stringContaining('id: caller.id')]);
    expect(src.indexOf('if (caller) {')).toBeLessThan(src.indexOf('enforceActionAuth(env.DB'));
    expect(src).not.toMatch(/app_roles WHERE|roleSubjects/);
  });
});
