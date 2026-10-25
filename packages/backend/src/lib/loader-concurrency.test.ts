import { describe, expect, it } from 'vitest';
import { LOADER_MAX_CONCURRENT } from './app-worker-host.js';
import { createConcurrencyLimit, limitForScope } from './loader-concurrency.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createConcurrencyLimit', () => {
  it('rejects a limit that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => createConcurrencyLimit(bad), String(bad)).toThrow(RangeError);
  });

  it('lets the first N through immediately and makes the next one wait', async () => {
    const limit = createConcurrencyLimit(LOADER_MAX_CONCURRENT);
    const releases = await Promise.all(Array.from({ length: LOADER_MAX_CONCURRENT }, () => limit.acquire()));
    expect(limit.active).toBe(4);

    let fifthGranted = false;
    const fifth = limit.acquire().then((release) => { fifthGranted = true; return release; });
    await tick();
    expect(fifthGranted).toBe(false);
    expect(limit.waiting).toBe(1);

    releases[0]!();
    const release5 = await fifth;
    expect(fifthGranted).toBe(true);
    expect(limit.active).toBe(4); // the freed slot went straight to the waiter
    expect(limit.waiting).toBe(0);
    release5();
    releases.slice(1).forEach((release) => release());
    expect(limit.active).toBe(0);
  });

  it('serves waiters in arrival order', async () => {
    const limit = createConcurrencyLimit(1);
    const first = await limit.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) => limit.acquire().then((release) => { order.push(n); release(); }));
    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('never has more than N holders under a burst of 20', async () => {
    const limit = createConcurrencyLimit(4);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 20 }, async () => {
      const release = await limit.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      release();
    }));
    expect(peak).toBe(4);
    expect(limit.active).toBe(0);
  });

  it('ignores a second release of the same slot', async () => {
    const limit = createConcurrencyLimit(1);
    const release = await limit.acquire();
    release();
    release();
    expect(limit.active).toBe(0);
    await limit.acquire();
    let second = false;
    void limit.acquire().then(() => { second = true; });
    await tick();
    expect(second).toBe(false); // a double release did not mint a spare slot
  });
});

describe('limitForScope', () => {
  it('shares one limit per scope and keeps scopes apart', () => {
    const a = {};
    const b = {};
    expect(limitForScope(a, 4)).toBe(limitForScope(a, 4));
    expect(limitForScope(a, 4)).not.toBe(limitForScope(b, 4));
  });

  it('does not make one request queue behind another', async () => {
    const a = limitForScope({}, 1);
    const b = limitForScope({}, 1);
    await a.acquire();
    await expect(Promise.race([b.acquire().then(() => 'granted'), tick().then(() => 'blocked')])).resolves.toBe('granted');
  });
});
