import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #241: a new app scaffolded from a staged template must inherit the auth
 * hydration fix. Apps deploy with a frozen lockfile, so it is the templates'
 * locked SDK — not the range — that decides; both must be at or above the
 * release that introduced the explicit pending auth status. And a template
 * that gates on useAuth itself must wait while auth is pending.
 */

const AUTH_STATUS_SINCE = '1.16.61';
const TEMPLATES = join(__dirname, '../../../../templates');

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x![i]! !== y![i]!) return x![i]! > y![i]!;
  return true;
};

const templates = readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('template-'))
  .map((d) => d.name);

describe('staged templates inherit the pending auth status (#241)', () => {
  it('finds the staged templates', () => {
    // template-marketplace was published as its own GitHub template repository
    // and is no longer staged here (#199); three staged templates remain.
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of templates) {
    it(`${name}: SDK range and lockfile are at ${AUTH_STATUS_SINCE} or later`, () => {
      const range = (JSON.parse(readFileSync(join(TEMPLATES, name, 'web/package.json'), 'utf8')) as { dependencies: Record<string, string> })
        .dependencies['@proappstore/sdk']!;
      expect(range, 'range').toMatch(/^\^\d+\.\d+\.\d+$/);
      expect(newer(range.slice(1), AUTH_STATUS_SINCE), `range ${range}`).toBe(true);
      const lock = readFileSync(join(TEMPLATES, name, 'pnpm-lock.yaml'), 'utf8');
      const locked = /'@proappstore\/sdk':\s*\n\s*specifier: [^\n]+\n\s*version: (\d+\.\d+\.\d+)/.exec(lock)?.[1];
      expect(locked, 'locked version').toBeDefined();
      expect(newer(locked!, AUTH_STATUS_SINCE), `locked ${locked}`).toBe(true);
    });

    it(`${name}: gates on auth through ProShell, or waits for useAuth's loading/status before treating "no user" as signed out`, () => {
      const app = readFileSync(join(TEMPLATES, name, 'web/src/App.tsx'), 'utf8');
      expect(app, 'renders through ProShell').toMatch(/<ProShell\b/);
      if (/\buseAuth\(/.test(app)) {
        const gate = app.slice(app.indexOf('useAuth('));
        const waits = gate.search(/\bif \((loading|status === 'pending')\)/);
        const signedOut = gate.search(/\bif \(!user\)/);
        if (signedOut !== -1) {
          expect(waits, 'checks loading before !user').toBeGreaterThan(-1);
          expect(waits).toBeLessThan(signedOut);
        }
      }
    });
  }
});
