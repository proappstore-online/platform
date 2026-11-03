import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineStore, type OfflineStore } from './store.js';
import { createDownloadManager, type DownloadManifest } from './downloads.js';

let store: OfflineStore;
const bytes = new TextEncoder().encode('你好，Chinese audio');
let manifest: DownloadManifest;
const response = (data: Uint8Array = bytes, status = 200, headers: Record<string, string> = {}) => new Response(data, { status, headers: { ETag: '"v1"', ...headers } });
beforeEach(async () => {
  store = createOfflineStore({ appId: 'reader', scope: { kind: 'device' }, indexedDB: new IDBFactory() });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
  manifest = { id: 'voice', version: '1', url: 'https://cdn.example/model.bin', sha256, bytes: bytes.length };
});
const key = () => JSON.stringify([manifest.id, manifest.version, manifest.sha256, manifest.bytes, manifest.url]);

describe('verified offline downloads', () => {
  it('commits verified bytes, reloads without fetch and removes metadata and blobs together', async () => {
    const fetcher = vi.fn(async () => response());
    const manager = createDownloadManager(store, { fetch: fetcher, checkpointBytes: 4 });
    const progress = vi.fn();
    expect(await manager.get(manifest)).toBeNull();
    expect(await manager.status(manifest)).toBeNull();
    expect(await (await manager.download(manifest, { onProgress: progress })).text()).toBe('你好，Chinese audio');
    expect(await manager.status(manifest)).toEqual({ state: 'ready', loaded: bytes.length, total: bytes.length });
    expect((await manager.get(manifest))?.size).toBe(bytes.length);
    await manager.download(manifest);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(progress).toHaveBeenLastCalledWith({ loaded: bytes.length, total: bytes.length, resumed: false });
    await manager.remove(manifest);
    expect(await manager.get(manifest)).toBeNull();
    expect(await store.page('blobs')).toEqual([]);
  });

  it('persists interrupted chunks and validates exact Range and ETag after reload', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(bytes.slice(0, 5))).mockResolvedValueOnce(response(bytes.slice(5), 206, { 'Content-Range': `bytes 5-${bytes.length - 1}/${bytes.length}` }));
    const manager = createDownloadManager(store, { fetch: fetcher, checkpointBytes: 4 });
    await expect(manager.download(manifest)).rejects.toMatchObject({ code: 'network' });
    expect(await manager.status(manifest)).toMatchObject({ state: 'partial', loaded: 5 });
    const progress = vi.fn();
    await createDownloadManager(store, { fetch: fetcher }).download(manifest, { onProgress: progress });
    const headers = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(headers.get('Range')).toBe('bytes=5-');
    expect(headers.get('If-Range')).toBe('"v1"');
    expect(progress).toHaveBeenLastCalledWith({ loaded: bytes.length, total: bytes.length, resumed: true });
  });

  it('safely restarts ignored ranges and weak validators', async () => {
    for (const etag of ['"v1"', 'W/"v1"']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(bytes.slice(0, 3), 200, { ETag: etag })).mockResolvedValueOnce(response());
      const manager = createDownloadManager(store, { fetch: fetcher });
      await expect(manager.download(manifest)).rejects.toMatchObject({ code: 'network' });
      const progress = vi.fn();
      await manager.download(manifest, { onProgress: progress });
      expect(progress).toHaveBeenLastCalledWith({ loaded: bytes.length, total: bytes.length, resumed: false });
      if (etag.startsWith('W')) expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has('Range')).toBe(false);
      await manager.remove(manifest);
    }
  });

  it.each([
    { ETag: '"changed"', 'Content-Range': `bytes 3-${bytes.length - 1}/${bytes.length}` },
    { ETag: '"v1"', 'Content-Range': `bytes 2-${bytes.length - 1}/${bytes.length}` },
    { ETag: '"v1"', 'Content-Range': 'malformed' },
  ])('rejects invalid resumed responses %j and clears untrusted chunks', async (headers) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(bytes.slice(0, 3))).mockResolvedValueOnce(response(bytes.slice(3), 206, headers));
    const manager = createDownloadManager(store, { fetch: fetcher });
    await expect(manager.download(manifest)).rejects.toMatchObject({ code: 'network' });
    await expect(manager.download(manifest)).rejects.toMatchObject({ code: 'integrity' });
    expect(await manager.status(manifest)).toBeNull();
    expect(await store.page('blobs')).toEqual([]);
  });

  it('rejects wrong hashes, oversized bodies, HTTP failures, unsolicited ranges and missing bodies', async () => {
    const cases = [
      { value: response(new Uint8Array(bytes.length)), code: 'integrity' },
      { value: response(new Uint8Array(bytes.length + 1)), code: 'integrity' },
      { value: response(bytes, 500), code: 'network' },
      { value: response(bytes, 206), code: 'integrity' },
      { value: new Response(null), code: 'network' },
    ];
    for (const { value, code } of cases) {
      const manager = createDownloadManager(store, { fetch: vi.fn(async () => value) });
      await expect(manager.download(manifest)).rejects.toMatchObject({ code });
      expect(await manager.get(manifest)).toBeNull();
    }
  });

  it('revalidates ready bytes after eviction or corruption', async () => {
    for (const missing of [true, false]) {
      const manager = createDownloadManager(store, { fetch: vi.fn(async () => response()) });
      await manager.download(manifest);
      await store.transaction(['blobs'], 'readwrite', (tx, done) => {
        if (missing) tx.objectStore('blobs').delete(`download-ready:${key()}`);
        else tx.objectStore('blobs').put(new Blob(['corrupted']), `download-ready:${key()}`);
        done(undefined);
      });
      await expect(manager.get(manifest)).rejects.toMatchObject({ code: 'integrity' });
      expect(await manager.status(manifest)).toBeNull();
    }
  });

  it('checkpoints cancellation and later verifies a completely downloaded partial without network', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => response());
    const manager = createDownloadManager(store, { fetch: fetcher });
    await expect(manager.download(manifest, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await manager.status(manifest)).toMatchObject({ state: 'partial', loaded: bytes.length });
    await manager.download(manifest);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(manager.download(manifest, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a missing persisted chunk and locked account', async () => {
    const fetcher = vi.fn(async () => response());
    const manager = createDownloadManager(store, { fetch: fetcher });
    const controller = new AbortController();
    await expect(manager.download(manifest, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    await store.transaction(['blobs'], 'readwrite', (tx, done) => { tx.objectStore('blobs').clear(); done(undefined); });
    await expect(manager.download(manifest)).rejects.toMatchObject({ code: 'integrity' });
    let access = true;
    const account = createOfflineStore({ appId: 'reader', scope: { kind: 'account', ownerId: 'a' }, canAccess: () => access, indexedDB: new IDBFactory() });
    const privateManager = createDownloadManager(account, { fetch: vi.fn(async () => { access = false; return response(); }) });
    await expect(privateManager.download(manifest)).rejects.toMatchObject({ code: 'access-denied' });
  });

  it('validates limits, pinned manifests and public URLs before fetching', async () => {
    expect(() => createDownloadManager(store, { maxBytes: 0 })).toThrow();
    expect(() => createDownloadManager(store, { checkpointBytes: 0 })).toThrow();
    const fetcher = vi.fn();
    const manager = createDownloadManager(store, { fetch: fetcher });
    for (const bad of [{ id: '' }, { version: '' }, { sha256: 'abc' }, { bytes: 0 }, { url: 'relative' }, { url: 'http://example.com/x' }, { url: 'https://a:b@example.com/x' }, { url: 'https://a.example/.pas/auth/me' }, { url: 'https://api.proappstore.online/x' }, { url: 'https://data-app.proappstore.online/x' }]) {
      await expect(manager.download({ ...manifest, ...bad })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('purge rejects active downloads and cannot leave recreated content behind after retry', async () => {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const manager = createDownloadManager(store, { fetch: vi.fn(async () => { started(); await held; return response(); }) });
  const transfer = manager.download(manifest);
  await ready;
  await expect(store.clear()).rejects.toMatchObject({ code: 'busy' });
  release();
  await transfer;
  await store.clear();
  expect(await manager.status(manifest)).toBeNull();
  expect(await store.page('blobs')).toEqual([]);
});

describe('download lifecycle regressions (#529)', () => {
  it('retains verified cached bytes when SHA-256 becomes unavailable', async () => {
    const manager = createDownloadManager(store, { fetch: vi.fn(async () => response()) });
    await manager.download(manifest);
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {});
    try { await expect(manager.get(manifest)).rejects.toMatchObject({ code: 'unavailable' }); }
    finally { vi.stubGlobal('crypto', original); }
    expect(await manager.status(manifest)).toMatchObject({ state: 'ready' });
    expect((await manager.get(manifest))?.size).toBe(bytes.length);
  });

  it('does not publish progress after its account closes during a pending stream read', async () => {
    let emit: (chunk: Uint8Array) => void = () => {};
    let reading: () => void = () => {};
    const ready = new Promise<void>((resolve) => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(controller) { emit = (chunk) => controller.enqueue(chunk); }, pull() { reading(); } });
    const progress = vi.fn();
    const manager = createDownloadManager(store, { fetch: vi.fn(async () => new Response(body)), checkpointBytes: 1024 });
    const pending = manager.download(manifest, { onProgress: progress });
    await ready;
    // Wait until the manager, rather than the stream's initial prefetch, reads.
    await vi.waitFor(() => expect(body.locked).toBe(true));
    store.close(); emit(bytes.slice(0, 3));
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    expect(progress).not.toHaveBeenCalled();
  });
});

it('cancels a stalled response reader and keeps the originally requested download signal (#529)', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const original = new AbortController(), replacement = new AbortController();
  const options = { signal: original.signal };
  const manager = createDownloadManager(store, { fetch: vi.fn(async () => new Response(body)) });
  const pending = manager.download(manifest, options);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  options.signal = replacement.signal;
  await vi.waitFor(() => expect(body.locked).toBe(true));
  original.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(await manager.status(manifest)).toBeNull();
});

it.each(['cancel', 'close'])('does not publish completion after %s during ready-state commit (#529)', async (action) => {
  const controller = new AbortController();
  const transact = store.transaction.bind(store);
  let writes = 0;
  vi.spyOn(store, 'transaction').mockImplementation(async (tables, mode, work) => {
    const result = await transact(tables, mode, work);
    if (tables.includes('downloads') && mode === 'readwrite' && ++writes === 2) {
      if (action === 'cancel') controller.abort(); else store.close();
    }
    return result;
  });
  const progress = vi.fn();
  const manager = createDownloadManager(store, { fetch: vi.fn(async () => response()) });
  await expect(manager.download(manifest, { signal: controller.signal, onProgress: progress })).rejects.toMatchObject(action === 'cancel' ? { name: 'AbortError' } : { code: 'closed' });
  // The streamed-byte progress is allowed; final ready-state progress is not.
  expect(progress).toHaveBeenCalledOnce();
});

it('does not expose a verified cached blob after its handle closes in verification (#529)', async () => {
  const manager = createDownloadManager(store, { fetch: vi.fn(async () => response()) });
  await manager.download(manifest);
  const internal = manager as unknown as { verify(blob: Blob, manifest: DownloadManifest): Promise<void> };
  const verify = internal.verify.bind(manager);
  vi.spyOn(internal, 'verify').mockImplementation(async (blob, input) => { await verify(blob, input); store.close(); });
  await expect(manager.get(manifest)).rejects.toMatchObject({ code: 'closed' });
});

it('honors cancellation supplied by an inherited download signal getter (#529)', async () => {
  const controller = new AbortController(); controller.abort();
  class Options { get signal() { return controller.signal; } }
  const fetcher = vi.fn(async () => response());
  const manager = createDownloadManager(store, { fetch: fetcher });
  await expect(manager.download(manifest, new Options())).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled();
});
