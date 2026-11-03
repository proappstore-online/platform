import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineStore, type OfflineStore } from './store.js';
import { createLocalJobs, createSyncQueue } from './jobs.js';
import { offlineLock } from './locks.js';
import { createDownloadManager } from './downloads.js';
let store: OfflineStore;
beforeEach(() => { store = createOfflineStore({ appId: 'jobs', scope: { kind: 'device' }, indexedDB: new IDBFactory() }); });

describe('durable local jobs', () => {
  it('persists checkpoints, recovers interrupted work and completes from the saved point exactly once per concurrent runner', async () => {
    const jobs = createLocalJobs(store);
    await jobs.create({ id: 'j', kind: 'speech', input: '你好' });
    await jobs.checkpoint('j', { segment: 2 });
    await jobs.setStatus('j', 'running');
    const reopened = createLocalJobs(store);
    expect(await reopened.recover()).toBe(1);
    expect(await reopened.recover()).toBe(0);
    expect(await reopened.get('j')).toMatchObject({ status: 'interrupted', checkpoint: { segment: 2 } });
    const handler = vi.fn(async (input, context) => {
      expect(input).toBe('你好');
      expect(context.savedCheckpoint).toEqual({ segment: 2 });
      await context.checkpoint({ segment: 3 });
      return 'audio-id';
    });
    const results = await Promise.all([jobs.run('j', handler), reopened.run('j', handler)]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(results[1]).toMatchObject({ status: 'completed', result: 'audio-id', attempts: 1, checkpoint: { segment: 3 } });
    expect(await jobs.list()).toHaveLength(1);
  });

  it('persists failure and cancellation, allows explicit retry and never deletes work on close', async () => {
    const jobs = createLocalJobs(store);
    await jobs.create({ id: 'j', kind: 'speech', input: null });
    await expect(jobs.run('j', async () => { throw 'failed text'; })).rejects.toBe('failed text');
    expect(await jobs.get('j')).toMatchObject({ status: 'failed', error: 'failed text', attempts: 1 });
    const controller = new AbortController();
    await expect(jobs.run('j', async (_, context) => {
      await context.checkpoint('saved'); controller.abort(); await context.checkpoint('not saved');
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await jobs.get('j')).toMatchObject({ status: 'paused', checkpoint: 'saved', attempts: 2 });
    await expect(jobs.run('j', async () => {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await jobs.run('j', async () => 'done')).status).toBe('completed');
    store.close();
    await expect(jobs.get('j')).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects duplicate or missing work, invalid ids/status and stops writing when an account locks', async () => {
    const jobs = createLocalJobs(store);
    expect(() => jobs.create({ id: '', kind: 'x', input: null })).toThrow();
    await jobs.create({ id: 'j', kind: 'x', input: null });
    await expect(jobs.create({ id: 'j', kind: 'x', input: 'replacement' })).rejects.toMatchObject({ code: 'storage' });
    await expect(jobs.run('missing', async () => {})).rejects.toMatchObject({ code: 'invalid' });
    await expect(jobs.checkpoint('missing', 2)).rejects.toMatchObject({ code: 'storage' });
    await expect(jobs.setStatus('j', 'bad' as never)).rejects.toMatchObject({ code: 'invalid' });
    const original = new Error('account gone');
    await expect(jobs.run('j', async () => { store.close(); throw original; })).rejects.toBe(original);
  });
});

describe('explicit idempotent sync queue', () => {
  it('serializes concurrent flushes, keeps stable operation ids and never replays completed operations', async () => {
    const queue = createSyncQueue(store);
    await queue.enqueue({ id: 'a', kind: 'save', payload: { text: '你好' }, idempotent: true });
    const save = vi.fn(async (payload, context) => { expect(payload).toEqual({ text: '你好' }); expect(context.operationId).toBe('a'); });
    expect(await Promise.all([queue.flush({ save }), createSyncQueue(store).flush({ save })])).toEqual([{ completed: 1, failed: 0 }, { completed: 0, failed: 0 }]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await queue.get('a')).toMatchObject({ status: 'completed', attempts: 1 });
    expect(await queue.list()).toHaveLength(1);
    await expect(queue.enqueue({ id: 'a', kind: 'save', payload: 'replacement', idempotent: true })).rejects.toMatchObject({ code: 'storage' });
    expect(await queue.get('a')).toMatchObject({ payload: { text: '你好' } });
  });

  it('records failures, retries only explicitly, handles unknown types and honors flush bounds', async () => {
    const queue = createSyncQueue(store);
    await queue.enqueue({ id: 'a', kind: 'save', payload: 1, idempotent: true });
    await queue.enqueue({ id: 'b', kind: 'unknown', payload: 2, idempotent: true });
    expect(await queue.flush({ save: async () => { throw new Error('offline'); } }, { limit: 1 })).toEqual({ completed: 0, failed: 1 });
    expect(await queue.get('a')).toMatchObject({ status: 'failed', error: 'offline', attempts: 1 });
    expect(await queue.flush({})).toEqual({ completed: 0, failed: 1 });
    await queue.retry('a');
    expect(await queue.flush({ save: async () => {} })).toEqual({ completed: 1, failed: 0 });
    await expect(queue.retry('a')).rejects.toMatchObject({ code: 'invalid' });
    await expect(queue.retry('missing')).rejects.toMatchObject({ code: 'invalid' });
    expect(() => queue.flush({}, { limit: 0 })).toThrow();
    await expect(queue.enqueue({ id: 'c', kind: 'save', payload: 3, idempotent: false as never })).rejects.toMatchObject({ code: 'invalid' });
    await expect(queue.enqueue({ id: '', kind: 'save', payload: 3, idempotent: true })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('recovers abandoned running operations with the original id and retains cancelled pending work', async () => {
    const queue = createSyncQueue(store);
    const row = await queue.enqueue({ id: 'a', kind: 'save', payload: 1, idempotent: true });
    await store.write('outbox', 'a', { ...row, status: 'running', attempts: 1 });
    const controller = new AbortController();
    await expect(queue.flush({ save: async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); } }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await queue.get('a')).toMatchObject({ status: 'pending', attempts: 2 });
    await expect(queue.flush({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await queue.flush({ save: async () => {} })).toEqual({ completed: 1, failed: 0 });
    expect(await queue.get('a')).toMatchObject({ attempts: 3 });
  });
});

it('uses browser cross-context locks and refuses unsafe browser fallback', async () => {
  const request = vi.fn(async (_name, _options, callback) => callback({}));
  vi.stubGlobal('navigator', { locks: { request } });
  expect(await offlineLock('test', async () => 2, true)).toBe(2);
  expect(request).toHaveBeenCalled();
  vi.stubGlobal('navigator', {}); vi.stubGlobal('window', {});
  await expect(offlineLock('test', async () => 2, true)).rejects.toMatchObject({ code: 'unavailable' });
  vi.unstubAllGlobals();
});

it('allows nested work leases and refuses purge promptly without deadlocking a handler', async () => {
  const jobs = createLocalJobs(store);
  await jobs.create({ id: 'nested', kind: 'speech', input: null });
  const result = await jobs.run('nested', async () => {
    await expect(store.clear()).rejects.toMatchObject({ code: 'busy' });
    const data = new TextEncoder().encode('voice');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (n) => n.toString(16).padStart(2, '0')).join('');
    const manager = createDownloadManager(store, { fetch: vi.fn(async () => new Response(data)) });
    const blob = await manager.download({ id: 'voice', version: '1', url: 'https://cdn.example/voice', sha256: digest, bytes: data.length });
    return blob.text();
  });
  expect(result.result).toBe('voice');
  await store.clear();
  expect(await jobs.get('nested')).toBeNull();
});

it('orders new shared work after an already-held purge lease', async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const clear = offlineLock('ordering', async () => { order.push('clear-start'); started(); await gate; order.push('clear-end'); }, false, { ifAvailable: true });
  const run = offlineLock('ordering', async () => { order.push('work'); }, false, { mode: 'shared' });
  await ready;
  expect(order).toEqual(['clear-start']);
  release(); await Promise.all([clear, run]);
  expect(order).toEqual(['clear-start', 'clear-end', 'work']);
});
