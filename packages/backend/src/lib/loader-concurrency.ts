/**
 * ADR-009 §5: Cloudflare allows at most 4 distinct Dynamic Workers in flight per
 * Worker request. The platform enforces it too, rather than leaning on a
 * runtime failure: a fifth load WAITS for one of the four to settle, so a caller
 * that fans out (a queue batch, a scheduler tick) degrades to slower, never to
 * an error.
 */

export interface ConcurrencyLimit {
  /** Resolves with a release function once a slot is free. Releasing twice is harmless. */
  acquire(): Promise<() => void>;
  /** Slots in use right now. */
  readonly active: number;
  /** Callers waiting for a slot. */
  readonly waiting: number;
}

export function createConcurrencyLimit(max: number): ConcurrencyLimit {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`concurrency limit must be a positive integer, got ${max}`);
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = () => {
    // Hand the slot straight to the next waiter (FIFO) without ever dropping `active` below the true count.
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  return {
    acquire() {
      const take = () => {
        let released = false;
        return () => { if (!released) { released = true; release(); } };
      };
      if (active < max) {
        active++;
        return Promise.resolve(take());
      }
      return new Promise<() => void>((resolve) => { waiters.push(() => resolve(take())); });
    },
    get active() { return active; },
    get waiting() { return waiters.length; },
  };
}

const scopes = new WeakMap<object, ConcurrencyLimit>();

/**
 * The limit shared by everything running under one request: keyed on the
 * request's own execution context, so unrelated requests in the same isolate
 * never queue behind each other (the cap is per request, not per isolate).
 */
export function limitForScope(scope: object, max: number): ConcurrencyLimit {
  let limit = scopes.get(scope);
  if (!limit) {
    limit = createConcurrencyLimit(max);
    scopes.set(scope, limit);
  }
  return limit;
}
