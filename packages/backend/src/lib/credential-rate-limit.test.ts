import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimAttempt, recordSuccess, MAX_ATTEMPTS, WINDOW_MS } from './credential-rate-limit.js';

// Against real SQLite (node:sqlite), the same SQL D1 runs. The adapter awaits
// before each statement, so claims started together interleave the way
// parallel requests do.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(new URL('../../../../migrations/0029_credential_accounts.sql', import.meta.url), 'utf8');
const T = 1_000_000;

let sqlite: InstanceType<typeof DatabaseSync>;
const db = {
  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async () => { await Promise.resolve(); return (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null; },
        run: async () => { await Promise.resolve(); return { meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }; },
      }),
    };
  },
} as unknown as D1Database;
const row = (key: string) => sqlite.prepare('SELECT window_start, count FROM credential_login_attempts WHERE login = ?').get(key);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, credential_login TEXT);');
  sqlite.exec(MIGRATION.replace(/^ALTER TABLE.*$/gm, ''));
});

describe('credential attempt limiting (fixed window, atomic claim)', () => {
  it('allows MAX_ATTEMPTS claims in a window, then refuses', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(await claimAttempt(db, 'wolf-fox-bear', T)).toBe(true);
    expect(await claimAttempt(db, 'wolf-fox-bear', T)).toBe(false);
    expect(await claimAttempt(db, 'other', T)).toBe(true); // keys are independent
  });

  it('parallel claims cannot exceed MAX_ATTEMPTS: each gets a distinct count', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => claimAttempt(db, 'cat', T)));
    expect(results.filter(Boolean)).toHaveLength(MAX_ATTEMPTS);
    expect(row('cat')).toEqual({ window_start: T, count: 50 });
  });

  it('a locked key stays locked inside the window and restarts once it expires', async () => {
    for (let i = 0; i <= MAX_ATTEMPTS; i++) await claimAttempt(db, 'cat', T);
    expect(await claimAttempt(db, 'cat', T + WINDOW_MS - 1)).toBe(false);
    expect(row('cat')).toMatchObject({ window_start: T }); // claims while locked do not extend the window
    expect(await claimAttempt(db, 'cat', T + WINDOW_MS)).toBe(true);
    expect(row('cat')).toEqual({ window_start: T + WINDOW_MS, count: 1 });
  });

  it('a success clears the counter', async () => {
    for (let i = 0; i <= MAX_ATTEMPTS; i++) await claimAttempt(db, 'pug', T);
    await recordSuccess(db, 'pug');
    expect(row('pug')).toBeUndefined();
    expect(await claimAttempt(db, 'pug', T)).toBe(true);
  });
});
