import { describe, expect, it } from 'vitest';
import {
  isBlocked, recordFailure, recordSuccess, MAX_ATTEMPTS, WINDOW_MS,
  type AttemptStore, type AttemptRow,
} from './credential-rate-limit.js';

function memStore(): AttemptStore {
  const m = new Map<string, AttemptRow>();
  return {
    async read(login) { return m.get(login) ?? null; },
    async set(login, row) { m.set(login, { ...row }); },
    async clear(login) { m.delete(login); },
  };
}

describe('credential login rate limiting (fixed window)', () => {
  it('is not blocked until MAX_ATTEMPTS failures within the window', async () => {
    const store = memStore();
    const t = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await recordFailure(store, 'wolf-fox-bear', t);
      expect(await isBlocked(store, 'wolf-fox-bear', t)).toBe(false);
    }
    await recordFailure(store, 'wolf-fox-bear', t);
    expect(await isBlocked(store, 'wolf-fox-bear', t)).toBe(true);
  });

  it('resets the window once it expires', async () => {
    const store = memStore();
    const t = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(store, 'cat', t);
    expect(await isBlocked(store, 'cat', t)).toBe(true);
    // After the window, no longer blocked; next failure opens a fresh window.
    expect(await isBlocked(store, 'cat', t + WINDOW_MS)).toBe(false);
    await recordFailure(store, 'cat', t + WINDOW_MS);
    const row = await store.read('cat');
    expect(row?.count).toBe(1);
  });

  it('clears the counter on success', async () => {
    const store = memStore();
    const t = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordFailure(store, 'pug', t);
    expect(await isBlocked(store, 'pug', t)).toBe(true);
    await recordSuccess(store, 'pug');
    expect(await isBlocked(store, 'pug', t)).toBe(false);
    expect(await store.read('pug')).toBeNull();
  });
});
