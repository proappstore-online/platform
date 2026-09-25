import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPATIBILITY_DATE } from '../../config/shared';

const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const toml = readFileSync(root('packages/backend/wrangler.toml'), 'utf8');
const types = readFileSync(root('packages/backend/src/types.ts'), 'utf8');

/** `binding = "X"` names inside a `[[section]]` or `[section]` block. */
function bindings(section: string): string[] {
  const re = new RegExp(`\\[\\[?${section.replace('.', '\\.')}\\]\\]?[^[]*`, 'g');
  return [...toml.matchAll(re)].flatMap((m) => [...m[0].matchAll(/binding\s*=\s*"([A-Z_]+)"/g)].map((b) => b[1]!));
}

// Wrangler config drift the mocked suite cannot observe: every binding the Env
// type requires exists in wrangler.toml, and the D1 migrations directory is the
// one the tests just applied.
describe('backend wrangler.toml matches the code', () => {
  it('declares every required binding of Env', () => {
    const required = [...types.matchAll(/^\s{2}([A-Z_]+):\s/gm)].map((m) => m[1]!);
    const declared = new Set([...bindings('d1_databases'), ...bindings('r2_buckets'), ...bindings('services'), ...bindings('analytics_engine_datasets'), ...bindings('ai'),
      ...[...toml.matchAll(/name\s*=\s*"([A-Z_]+)",\s*class_name/g)].map((m) => m[1]!)]);
    const vars = new Set([...toml.matchAll(/^([A-Z_]+)\s*=\s*"/gm)].map((m) => m[1]!));
    const secretsSyncedByDeploy = new Set(['SESSION_SIGNING_KEY', 'INTERNAL_TOKEN', 'R2_PARENT_ACCESS_KEY_ID', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CF_API_TOKEN', 'VAPID_PRIVATE_KEY']);
    for (const name of required) {
      expect(declared.has(name) || vars.has(name) || secretsSyncedByDeploy.has(name), `Env.${name} is required but wrangler.toml declares no binding, var or synced secret for it`).toBe(true);
    }
    expect(declared.has('DB') && declared.has('STORAGE') && declared.has('ROOM') && declared.has('SELF')).toBe(true);
  });

  it('points D1 migrations at the root sequence, whose numbers are ascending and not reused', () => {
    expect(toml).toMatch(/migrations_dir\s*=\s*"\.\.\/\.\.\/migrations"/);
    const files = readdirSync(root('migrations')).filter((f) => f.endsWith('.sql')).sort();
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    // 0025 was used twice in 2026-06 and 2026-08 (team_members, service_payouts).
    // Both are applied in production under their file names, and wrangler tracks
    // migrations by name, so renaming one would re-run it. The pair stays; any
    // further reuse of a number fails here.
    const KNOWN_DUPLICATES = new Set([25]);
    const seen = new Set<number>();
    for (const n of numbers) {
      expect(!seen.has(n) || KNOWN_DUPLICATES.has(n), `migration number ${String(n).padStart(4, '0')} is reused`).toBe(true);
      seen.add(n);
    }
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(numbers[0]).toBe(1);
  });

  it('has a cron trigger for the scheduled handler and exports it', () => {
    expect(toml).toMatch(/\[triggers\][\s\S]*crons\s*=\s*\[/);
    expect(readFileSync(root('packages/backend/src/index.ts'), 'utf8')).toMatch(/scheduled/);
  });

  it('the runtime suite pins a compatibility date no newer than production', () => {
    const prod = /compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(toml)![1]!;
    expect(COMPATIBILITY_DATE <= prod).toBe(true);
  });
});

/**
 * The same drift check for the other Workers the runtime suite now runs (#23):
 * every binding, var or deploy-synced secret the Worker's Env type REQUIRES
 * (no `?`) is declared in its wrangler.toml. A binding that exists in the type
 * but not in the config is exactly the "works in the mocked suite, 500s in
 * production" class this suite exists for.
 */
describe.each([
  { pkg: 'agent-teams', envFile: 'src/bindings.ts', secrets: ['SESSION_SIGNING_KEY'] },
  { pkg: 'host', envFile: 'src/env.ts', secrets: [] as string[] },
  { pkg: 'admin', envFile: 'src/env.ts', secrets: ['CF_API_TOKEN', 'GITHUB_TOKEN', 'SESSION_SIGNING_KEY'] },
])('$pkg wrangler.toml matches the code', ({ pkg, envFile, secrets }) => {
  const cfg = readFileSync(root(`packages/${pkg}/wrangler.toml`), 'utf8');
  const env = readFileSync(root(`packages/${pkg}/${envFile}`), 'utf8');
  const blocks = (section: string) => [...cfg.matchAll(new RegExp(`\\[\\[?${section.replace(/\./g, '\\.')}\\]\\]?[^[]*`, 'g'))].map((m) => m[0]);
  const named = (section: string, key: string) => blocks(section).flatMap((b) => [...b.matchAll(new RegExp(`${key}\\s*=\\s*"([A-Z_]+)"`, 'g'))].map((m) => m[1]!));

  it('declares every required binding of Env', () => {
    const required = [...env.matchAll(/^\s{2}([A-Z_]+):\s/gm)].map((m) => m[1]!);
    expect(required.length).toBeGreaterThan(2);
    const declared = new Set([
      ...named('d1_databases', 'binding'), ...named('r2_buckets', 'binding'), ...named('services', 'binding'),
      ...named('workflows', 'binding'), ...named('ai', 'binding'), ...named('durable_objects.bindings', 'name'),
    ]);
    const vars = new Set([...cfg.matchAll(/^([A-Z_]+)\s*=\s*"/gm)].map((m) => m[1]!));
    for (const name of required) {
      expect(declared.has(name) || vars.has(name) || secrets.includes(name), `${pkg}: Env.${name} is required but wrangler.toml declares no binding, var or synced secret for it`).toBe(true);
    }
  });

  it('every Durable Object class it binds is exported by its entry module', () => {
    const classes = [...cfg.matchAll(/class_name\s*=\s*"(\w+)"/g)].map((m) => m[1]!);
    const entry = readFileSync(root(`packages/${pkg}/src/index.ts`), 'utf8');
    for (const cls of classes) expect(entry, `${pkg}: ${cls} must be exported from src/index.ts`).toMatch(new RegExp(`export \\{[^}]*\\b${cls}\\b|export class ${cls}\\b`));
  });

  it('pins a compatibility date the runtime suite can run', () => {
    const prod = /compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(cfg)![1]!;
    expect(prod >= '2024-12-01').toBe(true);
  });
});
