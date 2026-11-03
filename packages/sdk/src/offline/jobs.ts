import { OfflineError, type LocalPage, type OfflineStore } from './store.js';
import { offlineLock } from './locks.js';

export type LocalJobStatus = 'pending' | 'running' | 'paused' | 'interrupted' | 'completed' | 'failed';
export interface LocalJob<I = unknown, C = unknown, R = unknown> {
  id: string; kind: string; input: I; checkpoint: C | null; result: R | null;
  status: LocalJobStatus; attempts: number; updatedAt: number; error: string | null;
}
export interface LocalJobContext<C = unknown> { savedCheckpoint: C | null; checkpoint: (value: C) => Promise<void>; signal: AbortSignal | undefined }
export type LocalJobHandler<I = unknown, C = unknown, R = unknown> = (input: I, context: LocalJobContext<C>) => Promise<R>;
const validId = (id: string) => {
  if (!id || id.length > 256) throw new OfflineError('invalid', 'Work ids must contain 1–256 characters.');
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Work cancelled.', 'AbortError'); };

export class LocalJobs {
  constructor(private readonly store: OfflineStore) {}
  create<I>(input: { id: string; kind: string; input: I }): Promise<LocalJob<I>> {
    validId(input.id); validId(input.kind);
    return this.store.transaction(['jobs'], 'readwrite', (tx, done) => {
      const request = tx.objectStore('jobs').get(input.id);
      request.onsuccess = () => {
        if (request.result) { tx.abort(); return; }
        const row: LocalJob<I> = { ...input, checkpoint: null, result: null, status: 'pending', attempts: 0, updatedAt: Date.now(), error: null };
        tx.objectStore('jobs').put(row, row.id); done(row);
      };
    });
  }
  get<I = unknown, C = unknown, R = unknown>(id: string): Promise<LocalJob<I, C, R> | null> { return this.store.read('jobs', id); }
  list(options: LocalPage = {}): Promise<LocalJob[]> { return this.store.page('jobs', options); }
  private update(id: string, change: (row: LocalJob) => LocalJob): Promise<LocalJob> {
    return this.store.transaction(['jobs'], 'readwrite', (tx, done) => {
      const request = tx.objectStore('jobs').get(id);
      request.onsuccess = () => {
        if (!request.result) { tx.abort(); return; }
        const next = { ...change(request.result as LocalJob), updatedAt: Date.now() };
        tx.objectStore('jobs').put(next, id); done(next);
      };
    });
  }
  async checkpoint<C>(id: string, value: C): Promise<void> { await this.update(id, (row) => ({ ...row, checkpoint: value })); }
  async setStatus(id: string, status: LocalJobStatus): Promise<void> {
    if (!['pending', 'running', 'paused', 'interrupted', 'completed', 'failed'].includes(status)) throw new OfflineError('invalid', 'Unknown local job status.');
    await this.update(id, (row) => ({ ...row, status }));
  }
  /** No automatic execution. Re-entering run() passes the last committed checkpoint. */
  async run<I = unknown, C = unknown, R = unknown>(id: string, handler: LocalJobHandler<I, C, R>, options: { signal?: AbortSignal } = {}): Promise<LocalJob<I, C, R>> {
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:jobs`, async () => {
      checkAbort(options.signal);
      const found = await this.get<I, C, R>(id);
      if (!found) throw new OfflineError('invalid', 'Local job does not exist.');
      if (found.status === 'completed') return found;
      await this.update(id, (row) => ({ ...row, status: 'running', attempts: row.attempts + 1, error: null }));
      try {
        const result = await handler(found.input, {
          savedCheckpoint: found.checkpoint, signal: options.signal,
          checkpoint: async (value) => { checkAbort(options.signal); await this.checkpoint(id, value); },
        });
        checkAbort(options.signal);
        return await this.update(id, (row) => ({ ...row, result, status: 'completed' })) as LocalJob<I, C, R>;
      } catch (error) {
        // A locked account deliberately prevents further writes; its running job
        // can be recovered after the owner explicitly opens it again.
        try { await this.update(id, (row) => ({ ...row, status: options.signal?.aborted ? 'paused' : 'failed', error: errorText(error) })); }
        catch { /* Preserve the original failure; no unlocked-account fallback. */ }
        throw error;
      }
    }, true, options.signal ? { signal: options.signal } : {}), options.signal);
  }
  /** The same Web Lock excludes active SDK runners before recovery. */
  async recover(): Promise<number> {
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:jobs`, () => this.store.transaction(['jobs'], 'readwrite', (tx, done) => {
      let count = 0;
      const request = tx.objectStore('jobs').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done(count); return; }
        const row = cursor.value as LocalJob;
        if (row.status === 'running') { cursor.update({ ...row, status: 'interrupted', updatedAt: Date.now() }); count++; }
        cursor.continue();
      };
    }), true));
  }
}

export interface SyncOperation { id: string; kind: string; payload: unknown; status: 'pending' | 'running' | 'failed' | 'completed'; attempts: number; updatedAt: number; error: string | null }
export type SyncHandler = (payload: unknown, context: { operationId: string; signal: AbortSignal | undefined }) => Promise<void>;

/** At-least-once delivery. Handlers MUST enforce server idempotency using operationId. */
export class SyncQueue {
  constructor(private readonly store: OfflineStore) {}
  async enqueue(input: { id: string; kind: string; payload: unknown; idempotent: true }): Promise<SyncOperation> {
    validId(input.id); validId(input.kind);
    if (input.idempotent !== true) throw new OfflineError('invalid', 'Only explicitly idempotent operations may be queued.');
    return this.store.transaction(['outbox'], 'readwrite', (tx, done) => {
      const request = tx.objectStore('outbox').get(input.id);
      request.onsuccess = () => {
        // A duplicate id cannot replace another payload (including after delivery).
        if (request.result) { tx.abort(); return; }
        const row: SyncOperation = { id: input.id, kind: input.kind, payload: input.payload, status: 'pending', attempts: 0, updatedAt: Date.now(), error: null };
        tx.objectStore('outbox').put(row, row.id); done(row);
      };
    });
  }
  get(id: string): Promise<SyncOperation | null> { return this.store.read('outbox', id); }
  list(options: LocalPage = {}): Promise<SyncOperation[]> { return this.store.page('outbox', options); }
  private async change(id: string, status: SyncOperation['status'], error: string | null, increment = false): Promise<void> {
    return this.store.transaction(['outbox'], 'readwrite', (tx, done) => {
      const request = tx.objectStore('outbox').get(id);
      request.onsuccess = () => {
        if (!request.result) { tx.abort(); return; }
        const row = request.result as SyncOperation;
        tx.objectStore('outbox').put({ ...row, status, error, attempts: row.attempts + Number(increment), updatedAt: Date.now() }, id); done(undefined);
      };
    });
  }
  retry(id: string): Promise<void> {
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:sync`, async () => {
      const row = await this.get(id);
      if (!row || row.status !== 'failed') throw new OfflineError('invalid', 'Only a failed operation can be retried.');
      await this.change(id, 'pending', null);
    }, true));
  }
  /** Explicit caller action; never triggered automatically by an online event. */
  flush(handlers: Record<string, SyncHandler>, options: { signal?: AbortSignal; limit?: number } = {}): Promise<{ completed: number; failed: number }> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new OfflineError('invalid', 'Flush limit must be between 1 and 200.');
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:sync`, async () => {
      checkAbort(options.signal);
      const pending = await this.store.transaction<SyncOperation[]>(['outbox'], 'readonly', (tx, done) => {
        const rows: SyncOperation[] = [];
        const request = tx.objectStore('outbox').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || rows.length >= limit) { done(rows); return; }
          const row = cursor.value as SyncOperation;
          // Running after acquiring the lock means a previous tab terminated.
          if (row.status === 'pending' || row.status === 'running') rows.push(row);
          cursor.continue();
        };
      });
      let completed = 0, failed = 0;
      for (const row of pending) {
        checkAbort(options.signal); this.store.assertAccess();
        const handler = Object.hasOwn(handlers, row.kind) ? handlers[row.kind] : undefined;
        if (!handler) { await this.change(row.id, 'failed', 'No handler registered for this operation.'); failed++; continue; }
        await this.change(row.id, 'running', null, true);
        try {
          await handler(row.payload, { operationId: row.id, signal: options.signal });
          await this.change(row.id, 'completed', null); completed++;
        } catch (error) {
          await this.change(row.id, options.signal?.aborted ? 'pending' : 'failed', errorText(error));
          if (options.signal?.aborted) throw error;
          failed++;
        }
      }
      return { completed, failed };
    }, true, options.signal ? { signal: options.signal } : {}), options.signal);
  }
}

export function createLocalJobs(store: OfflineStore): LocalJobs { return new LocalJobs(store); }
export function createSyncQueue(store: OfflineStore): SyncQueue { return new SyncQueue(store); }
