import { OfflineError } from './store.js';

// Web Locks coordinate tabs/workers. Non-browser tests use realm-local queues.
const queues = new Map<string, Promise<unknown>>();
const readers = new Map<string, number>();
export async function offlineLock<T>(name: string, work: () => Promise<T>, requireBrowserLock = false, options: { mode?: 'shared' | 'exclusive'; signal?: AbortSignal; ifAvailable?: boolean } = {}): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`pas:${name}`, options, (lock) => {
      if (!lock) throw new OfflineError('busy', 'Local work is active. Cancel or finish it before clearing storage.');
      return work();
    });
  }
  if (requireBrowserLock && (typeof window !== 'undefined' || typeof self !== 'undefined')) throw new OfflineError('unavailable', 'This browser cannot coordinate offline work between tabs.');
  const run = () => { if (options.signal?.aborted) throw new DOMException('Work cancelled.', 'AbortError'); return work(); };
  if (options.ifAvailable && ((readers.get(name) ?? 0) > 0 || queues.has(name))) throw new OfflineError('busy', 'Local work is active. Cancel or finish it before clearing storage.');
  if (options.mode === 'shared') {
    // Purge uses ifAvailable and never queues a writer ahead of nested readers.
    const exclusive = queues.get(name);
    if (exclusive) await exclusive.catch(() => {});
    readers.set(name, (readers.get(name) ?? 0) + 1);
    try { return await run(); }
    finally { const count = (readers.get(name) ?? 1) - 1; if (count) readers.set(name, count); else readers.delete(name); }
  }
  const prior = queues.get(name) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(run);
  queues.set(name, next);
  try { return await next; }
  finally { if (queues.get(name) === next) queues.delete(name); }
}
