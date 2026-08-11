import { describe, expect, it } from 'vitest';
import {
  MAX_VALIDATE_ATTEMPTS,
  VALIDATE_WINDOW_MS,
  consumeValidateAttempt,
  validateAttemptKey,
  type ValidateAttemptRow,
  type ValidateAttemptStore,
} from './license-rate-limit.js';

function fakeStore(seed: Record<string, ValidateAttemptRow> = {}) {
  const rows = new Map<string, ValidateAttemptRow>(Object.entries(seed));
  const writes: string[] = [];
  const store: ValidateAttemptStore = {
    async read(key) { return rows.get(key) ?? null; },
    async set(key, row) { writes.push(key); rows.set(key, row); },
  };
  return { store, rows, writes };
}

describe('validateAttemptKey', () => {
  it('scopes a caller to one app, so one app cannot spend another app budget', () => {
    expect(validateAttemptKey('1.2.3.4', 'appA')).not.toBe(validateAttemptKey('1.2.3.4', 'appB'));
  });
});

describe('consumeValidateAttempt', () => {
  const now = 1_800_000_000_000;
  const KEY = validateAttemptKey('1.2.3.4', 'myapp');

  it('opens a fresh window on the first attempt', async () => {
    const { store, rows } = fakeStore();
    expect(await consumeValidateAttempt(store, KEY, now)).toBe(true);
    expect(rows.get(KEY)).toEqual({ window_start: now, count: 1 });
  });

  it('counts up to the limit inside one window', async () => {
    const { store } = fakeStore({ [KEY]: { window_start: now, count: MAX_VALIDATE_ATTEMPTS - 1 } });
    expect(await consumeValidateAttempt(store, KEY, now + 100)).toBe(true);
  });

  it('refuses at the limit', async () => {
    const { store } = fakeStore({ [KEY]: { window_start: now, count: MAX_VALIDATE_ATTEMPTS } });
    expect(await consumeValidateAttempt(store, KEY, now + 100)).toBe(false);
  });

  it('does not write when refusing', async () => {
    // Two reasons: a blocked caller must not be able to push its own window
    // forward, and a caller hammering the endpoint stops costing D1 writes once
    // it is over the limit.
    const { store, writes, rows } = fakeStore({
      [KEY]: { window_start: now, count: MAX_VALIDATE_ATTEMPTS },
    });
    await consumeValidateAttempt(store, KEY, now + 100);
    expect(writes).toEqual([]);
    expect(rows.get(KEY)).toEqual({ window_start: now, count: MAX_VALIDATE_ATTEMPTS });
  });

  it('rolls the window once it has expired, even from a huge count', async () => {
    const { store, rows } = fakeStore({ [KEY]: { window_start: now, count: 9999 } });
    expect(await consumeValidateAttempt(store, KEY, now + VALIDATE_WINDOW_MS)).toBe(true);
    expect(rows.get(KEY)).toEqual({ window_start: now + VALIDATE_WINDOW_MS, count: 1 });
  });

  it('holds the window open right up to its final millisecond', async () => {
    const { store } = fakeStore({ [KEY]: { window_start: now, count: MAX_VALIDATE_ATTEMPTS } });
    expect(await consumeValidateAttempt(store, KEY, now + VALIDATE_WINDOW_MS - 1)).toBe(false);
  });

  it('keeps separate budgets per caller', async () => {
    const other = validateAttemptKey('5.6.7.8', 'myapp');
    const { store } = fakeStore({ [KEY]: { window_start: now, count: MAX_VALIDATE_ATTEMPTS } });
    expect(await consumeValidateAttempt(store, KEY, now)).toBe(false);
    expect(await consumeValidateAttempt(store, other, now)).toBe(true);
  });
});
