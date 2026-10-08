import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_VALIDATE_ATTEMPTS,
  VALIDATE_WINDOW_MS,
  consumeValidateAttempt,
  validateAttemptKey,
  validateIpKey,
} from './license-rate-limit.js';

// Against real SQLite (node:sqlite), the same SQL D1 runs. The adapter awaits
// before each statement, so claims started together interleave the way
// parallel requests do.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(new URL('../../../../migrations/0044_license_validate_attempts.sql', import.meta.url), 'utf8');

let sqlite: InstanceType<typeof DatabaseSync>;
let writes = 0;
const db = {
  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async () => {
          await Promise.resolve();
          const before = sqlite.prepare('SELECT total_changes() AS n').get() as { n: number };
          const row = (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null;
          writes += (sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before.n;
          return row;
        },
      }),
    };
  },
} as unknown as D1Database;
const row = (key: string) => sqlite.prepare('SELECT window_start, count FROM license_validate_attempts WHERE key = ?').get(key);
const seed = (key: string, window_start: number, count: number) =>
  sqlite.prepare('INSERT INTO license_validate_attempts (key, window_start, count) VALUES (?, ?, ?)').run(key, window_start, count);

const now = 1_800_000_000_000;
const KEY = validateAttemptKey('1.2.3.4', 'myapp');
const consume = (key: string, at: number) => consumeValidateAttempt(db, key, MAX_VALIDATE_ATTEMPTS, at);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(MIGRATION);
  writes = 0;
});

describe('bucket keys', () => {
  it('scopes a caller to one app, so one app cannot spend another app budget', () => {
    expect(validateAttemptKey('1.2.3.4', 'appA')).not.toBe(validateAttemptKey('1.2.3.4', 'appB'));
  });

  it('the per-IP ceiling key is one per IP, distinct from every per-app key', () => {
    expect(validateIpKey('1.2.3.4')).toBe('ip:1.2.3.4');
    expect(validateIpKey('1.2.3.4')).not.toBe(validateAttemptKey('1.2.3.4', 'ip'));
  });
});

describe('consumeValidateAttempt', () => {
  it('opens a fresh window on the first attempt', async () => {
    expect(await consume(KEY, now)).toBe(true);
    expect(row(KEY)).toEqual({ window_start: now, count: 1 });
  });

  it('counts up to the limit inside one window, then refuses', async () => {
    seed(KEY, now, MAX_VALIDATE_ATTEMPTS - 1);
    expect(await consume(KEY, now + 100)).toBe(true);
    expect(await consume(KEY, now + 100)).toBe(false);
  });

  it('does not write when refusing', async () => {
    // Two reasons: a blocked caller must not be able to push its own window
    // forward, and a caller hammering the endpoint stops costing D1 writes once
    // it is over the limit.
    seed(KEY, now, MAX_VALIDATE_ATTEMPTS);
    expect(await consume(KEY, now + 100)).toBe(false);
    expect(writes).toBe(0);
    expect(row(KEY)).toEqual({ window_start: now, count: MAX_VALIDATE_ATTEMPTS });
  });

  it('rolls the window once it has expired, even from a huge count', async () => {
    seed(KEY, now, 9999);
    expect(await consume(KEY, now + VALIDATE_WINDOW_MS)).toBe(true);
    expect(row(KEY)).toEqual({ window_start: now + VALIDATE_WINDOW_MS, count: 1 });
  });

  it('holds the window open right up to its final millisecond', async () => {
    seed(KEY, now, MAX_VALIDATE_ATTEMPTS);
    expect(await consume(KEY, now + VALIDATE_WINDOW_MS - 1)).toBe(false);
  });

  it('keeps separate budgets per caller', async () => {
    seed(KEY, now, MAX_VALIDATE_ATTEMPTS);
    expect(await consume(KEY, now)).toBe(false);
    expect(await consume(validateAttemptKey('5.6.7.8', 'myapp'), now)).toBe(true);
  });

  it('parallel claims cannot overshoot: exactly `limit` succeed, and the count stops there', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => consume(KEY, now)));
    expect(results.filter(Boolean)).toHaveLength(MAX_VALIDATE_ATTEMPTS);
    expect(row(KEY)).toEqual({ window_start: now, count: MAX_VALIDATE_ATTEMPTS });
  });

  it('enforces whatever limit it is given (the per-IP ceiling uses a larger one)', async () => {
    const ipKey = validateIpKey('1.2.3.4');
    for (let i = 0; i < 30; i++) expect(await consumeValidateAttempt(db, ipKey, 30, now)).toBe(true);
    expect(await consumeValidateAttempt(db, ipKey, 30, now)).toBe(false);
  });
});
