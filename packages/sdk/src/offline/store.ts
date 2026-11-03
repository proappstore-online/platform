import { offlineLock } from './locks.js';

/** Intentional local content, not a cache of authenticated API responses. */
export type OfflineScope = Readonly<{ kind: 'device' } | { kind: 'account'; ownerId: string }>;
export type OfflineErrorCode = 'unavailable' | 'closed' | 'access-denied' | 'quota' | 'blocked' | 'invalid' | 'storage' | 'integrity' | 'network' | 'busy';

export class OfflineError extends Error {
  constructor(public readonly code: OfflineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OfflineError';
  }
}

export type OfflineStoreOptions = { appId: string; indexedDB?: IDBFactory } & (
  | { scope: { kind: 'device' }; canAccess?: () => boolean }
  | { scope: { kind: 'account'; ownerId: string }; canAccess: () => boolean }
);
export interface LocalRecord<T = unknown> { id: string; value: T; updatedAt: number; blobBytes: number; blobType: string | null }
export interface LocalWrite<T = unknown> { id: string; value: T; blob?: Blob }
export interface LocalPage { after?: string; limit?: number }
export type OfflineTable = 'records' | 'blobs' | 'downloads' | 'jobs' | 'outbox';
const TABLES: OfflineTable[] = ['records', 'blobs', 'downloads', 'jobs', 'outbox'];
export const OFFLINE_SCHEMA_VERSION = 2;

export function offlineFailure(error: unknown): OfflineError {
  if (error instanceof OfflineError) return error;
  return new OfflineError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'storage',
    'Local storage operation failed.', { cause: error });
}

function key(value: string): string {
  if (!value || value.length > 512) throw new OfflineError('invalid', 'A non-empty key of at most 512 characters is required.');
  return value;
}

/** Every handle stays bound to one app/owner. close() locks it; clear() deletes it. */
export class OfflineStore {
  readonly scope: OfflineScope;
  readonly appId: string;
  readonly databaseName: string;
  private readonly factory: IDBFactory;
  private readonly canAccess: (() => boolean) | undefined;
  private closed = false;
  private readonly active = new Set<IDBTransaction>();

  constructor(options: OfflineStoreOptions) {
    this.appId = key(options.appId);
    this.scope = Object.freeze({ ...options.scope });
    if (this.scope.kind !== 'device' && this.scope.kind !== 'account') throw new OfflineError('invalid', 'Unknown local-content scope.');
    if (this.scope.kind === 'account') {
      key(this.scope.ownerId);
      if (typeof options.canAccess !== 'function') throw new OfflineError('invalid', 'Account-local content requires an explicit canAccess decision.');
    }
    this.canAccess = options.canAccess;
    this.databaseName = `pas-offline:${JSON.stringify([this.appId, this.scope.kind, this.scope.kind === 'account' ? this.scope.ownerId : null])}`;
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new OfflineError('unavailable', 'IndexedDB is unavailable on this device.');
    this.factory = factory;
    this.assertAccess();
  }

  assertAccess(): void {
    if (this.closed) throw new OfflineError('closed', 'This local-content handle has been closed.');
    if (this.canAccess && !this.canAccess()) {
      this.close();
      throw new OfflineError('access-denied', 'Local content is locked for this account.');
    }
  }

  close(): void {
    this.closed = true;
    for (const tx of this.active) { try { tx.abort(); } catch { /* Already committed. */ } }
  }

  private open(): Promise<IDBDatabase> {
    this.assertAccess();
    return new Promise((resolve, reject) => {
      let refused = false;
      let request: IDBOpenDBRequest;
      try { request = this.factory.open(this.databaseName, OFFLINE_SCHEMA_VERSION); }
      catch (error) { reject(offlineFailure(error)); return; }
      request.onupgradeneeded = () => {
        // Version 1 held records/blobs; version 2 adds resumable work. Existing data survives.
        for (const table of TABLES) if (!request.result.objectStoreNames.contains(table)) request.result.createObjectStore(table);
      };
      request.onblocked = () => {
        refused = true;
        reject(new OfflineError('blocked', 'Another tab is blocking the local database upgrade. Close it and retry.'));
      };
      request.onerror = () => reject(offlineFailure(request.error));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (refused) { db.close(); return; }
        try { this.assertAccess(); resolve(db); }
        catch (error) { db.close(); reject(error); }
      };
    });
  }

  /** @internal Shared transaction primitive for the opt-in offline modules. */
  async transaction<T>(tables: OfflineTable[], mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    try {
      this.assertAccess();
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(tables, mode);
        this.active.add(tx);
        let value: T;
        let thrown: unknown;
        tx.oncomplete = () => {
          this.active.delete(tx);
          try { this.assertAccess(); resolve(value); } catch (error) { reject(error); }
        };
        tx.onabort = () => { this.active.delete(tx); reject(offlineFailure(thrown ?? tx.error)); };
        tx.onerror = () => { /* onabort is authoritative; requests abort by default. */ };
        try { work(tx, (next) => { value = next; }); }
        catch (error) { thrown = error; tx.abort(); }
      });
    } catch (error) { throw offlineFailure(error); }
    finally { db.close(); }
  }

  /** @internal */
  read<T>(table: OfflineTable, id: string): Promise<T | null> {
    return this.transaction([table], 'readonly', (tx, done) => {
      const request = tx.objectStore(table).get(id);
      request.onsuccess = () => done((request.result as T | undefined) ?? null);
    });
  }

  /** @internal */
  write<T>(table: OfflineTable, id: string, value: T): Promise<void> {
    return this.transaction([table], 'readwrite', (tx, done) => { tx.objectStore(table).put(value, id); done(undefined); });
  }

  /** @internal Bounded cursor listing; metadata stores contain no audio bytes. */
  page<T>(table: OfflineTable, options: LocalPage = {}): Promise<T[]> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new OfflineError('invalid', 'Page limit must be between 1 and 200.');
    return this.transaction([table], 'readonly', (tx, done) => {
      const rows: T[] = [];
      const request = tx.objectStore(table).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) { done(rows); return; }
        if (options.after === undefined || String(cursor.key) > options.after) rows.push(cursor.value as T);
        if (rows.length === limit) done(rows); else cursor.continue();
      };
    });
  }

  async put<T>(entry: LocalWrite<T>): Promise<LocalRecord<T>> {
    key(entry.id);
    const record = { id: entry.id, value: entry.value, updatedAt: Date.now(), blobBytes: entry.blob?.size ?? 0, blobType: entry.blob?.type ?? null };
    return this.transaction(['records', 'blobs'], 'readwrite', (tx, done) => {
      tx.objectStore('records').put(record, entry.id);
      if (entry.blob) tx.objectStore('blobs').put(entry.blob, `record:${entry.id}`);
      else tx.objectStore('blobs').delete(`record:${entry.id}`);
      done(record);
    });
  }
  get<T = unknown>(id: string): Promise<LocalRecord<T> | null> { return this.read('records', key(id)); }
  getBlob(id: string): Promise<Blob | null> { return this.read('blobs', `record:${key(id)}`); }
  list<T = unknown>(options: LocalPage = {}): Promise<LocalRecord<T>[]> { return this.page('records', options); }
  delete(id: string): Promise<void> {
    key(id);
    return this.transaction(['records', 'blobs'], 'readwrite', (tx, done) => {
      tx.objectStore('records').delete(id); tx.objectStore('blobs').delete(`record:${id}`); done(undefined);
    });
  }
  /** @internal Shared lease excludes purge until durable work finishes. */
  runWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return offlineLock(`${this.databaseName}:work`, work, true, { mode: 'shared', ...(signal ? { signal } : {}) });
  }
  /** Rejects busy while SDK jobs/downloads/sync are active. Cancel and await runners before retrying. */
  clear(): Promise<void> {
    return offlineLock(`${this.databaseName}:work`, () => this.transaction(TABLES, 'readwrite', (tx, done) => { for (const table of TABLES) tx.objectStore(table).clear(); done(undefined); }), true, { ifAvailable: true });
  }
  /** Portable JSON export of one user-selected record, including an optional base64 blob. */
  async exportRecord(id: string): Promise<Blob> {
    const snapshot = await this.transaction<{ record: LocalRecord | null; blob: Blob | null }>(['records', 'blobs'], 'readonly', (tx, done) => {
      const record = tx.objectStore('records').get(key(id));
      const blob = tx.objectStore('blobs').get(`record:${id}`);
      blob.onsuccess = () => done({ record: record.result ?? null, blob: blob.result ?? null });
    });
    if (!snapshot.record) throw new OfflineError('invalid', 'The local record does not exist.');
    let base64: string | null = null;
    if (snapshot.blob) {
      const bytes = new Uint8Array(await snapshot.blob.arrayBuffer());
      const parts: string[] = [];
      for (let start = 0; start < bytes.length; start += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
      base64 = btoa(parts.join(''));
    }
    this.assertAccess();
    return new Blob([JSON.stringify({ format: 'pas-local-record', version: 1, appId: this.appId, scope: this.scope, record: snapshot.record, base64 })], { type: 'application/json' });
  }
}

export function createOfflineStore(options: OfflineStoreOptions): OfflineStore { return new OfflineStore(options); }

/** Call on explicit logout/account changes; closing never deletes unsynced work. */
export function bindOfflineAccount(store: OfflineStore, auth: { onChange: (listener: (user: { id: string } | null) => void) => () => void }): () => void {
  const scope = store.scope;
  if (scope.kind !== 'account') throw new OfflineError('invalid', 'Only account-local stores bind to account changes.');
  // Broadcast only a revocation bit within this app/owner namespace; never credentials.
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`${store.databaseName}:access`);
  if (channel) channel.onmessage = (event) => { if (event.data === 'lock') store.close(); };
  const unsubscribe = auth.onChange((user) => {
    if (!user || user.id !== scope.ownerId) { store.close(); channel?.postMessage('lock'); }
  });
  return () => { unsubscribe(); channel?.close(); };
}

/** Persistence is a request, never a promise that the browser cannot remove data. */
export async function localStorageStatus(requestPersistence = false): Promise<{ supported: boolean; persisted: boolean; usage: number | null; quota: number | null }> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage) return { supported: false, persisted: false, usage: null, quota: null };
  const estimate = await storage.estimate();
  const persisted = (await storage.persisted()) || (requestPersistence ? await storage.persist() : false);
  return { supported: true, persisted, usage: estimate.usage ?? null, quota: estimate.quota ?? null };
}
