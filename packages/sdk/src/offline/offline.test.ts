import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { bindOfflineAccount, createOfflineStore, localStorageStatus, OfflineError, OFFLINE_SCHEMA_VERSION } from '../offline.js';
import type { OfflineStoreOptions } from '../offline.js';
import { offlineFailure } from './store.js';

let factory: IDBFactory;
const device = (appId = 'test') => createOfflineStore({ appId, scope: { kind: 'device' }, indexedDB: factory });
beforeEach(() => { factory = new IDBFactory(); });
afterEach(() => vi.unstubAllGlobals());

describe('local content ownership and transaction lifecycle', () => {
  it('saves the submitted record even when its caller edits the input before commit', async () => {
    const store = device();
    const entry = { id: 'first', value: { title: 'original' }, blob: new Blob(['old'], { type: 'audio/wav' }) };
    const saving = store.put(entry);
    entry.id = 'second';
    entry.value.title = 'mutated';
    entry.blob = new Blob(['replacement'], { type: 'text/plain' });
    const saved = await saving;
    expect(saved).toMatchObject({ id: 'first', value: { title: 'original' }, blobBytes: 3, blobType: 'audio/wav' });
    expect(await store.get('first')).toEqual(saved);
    expect(await store.get('second')).toBeNull();
    expect(await (await store.getBlob('first'))!.text()).toBe('old');
  });

  it('keeps an in-flight page bound to its submitted cursor', async () => {
    const store = device();
    for (const id of ['a', 'b', 'c']) await store.put({ id, value: id });
    const options = { after: 'a', limit: 1 };
    const reading = store.list(options);
    options.after = 'b';
    options.limit = 2;
    expect((await reading).map((row) => row.id)).toEqual(['b']);
  });

  it('persists separately stored metadata and blobs across instances; paginates and exports', async () => {
    const a = device();
    await a.put({ id: 'a', value: { title: 'Lesson' }, blob: new Blob(['你好'], { type: 'text/plain' }) });
    await a.put({ id: 'b', value: 2 });
    a.close();
    const b = device();
    expect(await b.get('a')).toMatchObject({ value: { title: 'Lesson' }, blobBytes: 6, blobType: 'text/plain' });
    expect(await (await b.getBlob('a'))!.text()).toBe('你好');
    expect(await b.list({ limit: 1 })).toHaveLength(1);
    expect((await b.list({ after: 'a' })).map((r) => r.id)).toEqual(['b']);
    expect(await b.list({ after: 'z' })).toEqual([]);
    const exported = JSON.parse(await (await b.exportRecord('a')).text());
    expect(exported).toMatchObject({ format: 'pas-local-record', version: 1, base64: '5L2g5aW9' });
    expect(JSON.parse(await (await b.exportRecord('b')).text()).base64).toBeNull();
    await b.put({ id: 'a', value: 'replaced without audio' });
    expect(await b.getBlob('a')).toBeNull();
    await b.delete('a');
    expect(await b.get('a')).toBeNull();
    await b.clear();
    expect(await b.list()).toEqual([]);
    await expect(b.exportRecord('absent')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('does not expose device or other-account content and permanently closes stale handles', async () => {
    let owner = 'alice';
    const a = createOfflineStore({ appId: 'test', scope: { kind: 'account', ownerId: 'alice' }, canAccess: () => owner === 'alice', indexedDB: factory });
    await a.put({ id: 'private', value: 'alice only' });
    expect(await device().get('private')).toBeNull();
    expect(await device('different-app').get('private')).toBeNull();
    owner = 'bob';
    const b = createOfflineStore({ appId: 'test', scope: { kind: 'account', ownerId: 'bob' }, canAccess: () => owner === 'bob', indexedDB: factory });
    expect(await b.get('private')).toBeNull();
    await expect(a.get('private')).rejects.toMatchObject({ code: 'access-denied' });
    owner = 'alice';
    await expect(a.get('private')).rejects.toMatchObject({ code: 'closed' });
    const reopened = createOfflineStore({ appId: 'test', scope: { kind: 'account', ownerId: owner }, canAccess: () => true, indexedDB: factory });
    expect(await reopened.get('private')).toMatchObject({ value: 'alice only' });
  });

  it('binds explicit account changes without deleting unsynced content', async () => {
    const store = createOfflineStore({ appId: 'test', scope: { kind: 'account', ownerId: 'alice' }, canAccess: () => true, indexedDB: factory });
    let listener!: (user: { id: string } | null) => void;
    const unsub = vi.fn();
    const dispose = bindOfflineAccount(store, { onChange: (fn) => { listener = fn; return unsub; } });
    await store.put({ id: 'draft', value: 1 });
    listener({ id: 'alice' });
    expect(await store.get('draft')).not.toBeNull();
    listener(null);
    await expect(store.get('draft')).rejects.toMatchObject({ code: 'closed' });
    expect(() => bindOfflineAccount(device(), { onChange: () => unsub })).toThrow('account-local');
    dispose(); expect(unsub).toHaveBeenCalled();
  });

  it('rejects invalid scopes/keys and unavailable storage explicitly', async () => {
    expect(() => createOfflineStore({ appId: '', scope: { kind: 'device' }, indexedDB: factory })).toThrow(OfflineError);
    expect(() => createOfflineStore({ appId: 'x', scope: { kind: 'account', ownerId: 'a' }, indexedDB: factory } as OfflineStoreOptions)).toThrow('canAccess');
    expect(() => createOfflineStore({ appId: 'x', scope: { kind: 'bad' }, indexedDB: factory } as unknown as OfflineStoreOptions)).toThrow('scope');
    expect(() => createOfflineStore({ appId: 'x', scope: { kind: 'device' } })).toThrow('unavailable');
    await expect(device().put({ id: '', value: 1 })).rejects.toMatchObject({ code: 'invalid' });
    expect(() => device().list({ limit: 201 })).toThrow('limit');
    expect(offlineFailure(new DOMException('full', 'QuotaExceededError')).code).toBe('quota');
    const expected = new OfflineError('busy', 'busy');
    expect(offlineFailure(expected)).toBe(expected);
  });

  it('aborts atomically when structured cloning fails and when a handle closes mid-transaction', async () => {
    const store = device();
    await store.put({ id: 'safe', value: 1, blob: new Blob(['original']) });
    await expect(store.put({ id: 'safe', value: () => 2, blob: new Blob(['bad']) })).rejects.toMatchObject({ code: 'storage' });
    expect(await store.get('safe')).toMatchObject({ value: 1 });
    await expect(store.transaction(['records'], 'readwrite', (tx, done) => {
      tx.objectStore('records').put({ id: 'new' }, 'new'); done(undefined); store.close();
    })).rejects.toMatchObject({ code: 'storage' });
    expect(await device().get('new')).toBeNull();
  });

  it('migrates version 1 without losing records, reports a blocked upgrade and retries safely', async () => {
    const store = device();
    const old = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(store.databaseName, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('records'); req.result.createObjectStore('blobs'); };
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise<void>((resolve) => { const tx = old.transaction('records', 'readwrite'); tx.objectStore('records').put({ id: 'old', value: 9 }, 'old'); tx.oncomplete = () => resolve(); });
    await expect(store.get('old')).rejects.toMatchObject({ code: 'blocked' });
    old.close();
    expect(await store.get('old')).toMatchObject({ value: 9 });
    expect(OFFLINE_SCHEMA_VERSION).toBeGreaterThan(1);
  });

  it('reports the actual storage persistence result', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(await localStorageStatus()).toMatchObject({ supported: false, persisted: false });
    const persist = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 1000, usage: 100 }), persisted: async () => false, persist } });
    expect(await localStorageStatus()).toEqual({ supported: true, persisted: false, usage: 100, quota: 1000 });
    expect(persist).not.toHaveBeenCalled();
    expect((await localStorageStatus(true)).persisted).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });
});

it('broadcasts revocation to another bound handle without deleting retained account records', async () => {
  const db = new IDBFactory();
  const options = { appId: 'shared', scope: { kind: 'account' as const, ownerId: 'a' }, canAccess: () => true, indexedDB: db };
  const first = createOfflineStore(options), second = createOfflineStore(options);
  await second.put({ id: 'keep', value: 'saved' });
  let revoke: (user: { id: string } | null) => void = () => {};
  const disposeFirst = bindOfflineAccount(first, { onChange: (fn) => { revoke = fn; return () => {}; } });
  const disposeSecond = bindOfflineAccount(second, { onChange: () => () => {} });
  revoke(null);
  await vi.waitFor(() => expect(() => second.assertAccess()).toThrow('closed'));
  disposeFirst(); disposeSecond();
  expect(await createOfflineStore(options).get('keep')).toMatchObject({ value: 'saved' });
});
