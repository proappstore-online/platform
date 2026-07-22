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
      '../../../agent-teams/src/project-do.ts',
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
