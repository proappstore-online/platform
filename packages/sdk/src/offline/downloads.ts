import { OfflineError, type OfflineStore } from './store.js';
import { offlineLock } from './locks.js';

// Adapted design from Glassdocs server/public/admin/audio/model.js (MIT):
// immutable version + SHA-256 pins, fail-closed integrity and explicit download
// progress. PAS adds bounded persisted chunks and validated range recovery.
export interface DownloadManifest { id: string; version: string; url: string; sha256: string; bytes: number }
export interface DownloadProgress { loaded: number; total: number; resumed: boolean }
export interface DownloadStatus { state: 'partial' | 'ready'; loaded: number; total: number }
interface DownloadRecord extends DownloadStatus { chunks: number; etag: string | null }
export interface DownloadOptions { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void }
export interface DownloadManagerOptions { fetch?: typeof fetch; maxBytes?: number; checkpointBytes?: number }

function assetKey(manifest: DownloadManifest, maxBytes: number): string {
  if (!manifest.id || manifest.id.length > 128 || !manifest.version || manifest.version.length > 128 ||
      !/^[a-f0-9]{64}$/i.test(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > maxBytes) {
    throw new OfflineError('invalid', 'Download requires an id, version, SHA-256 and byte size within the configured limit.');
  }
  let url: URL;
  try { url = new URL(manifest.url); } catch { throw new OfflineError('invalid', 'Download URL must be absolute.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password ||
      url.pathname.startsWith('/.pas/') || url.hostname === 'api.proappstore.online' || url.hostname.startsWith('data-')) {
    throw new OfflineError('invalid', 'Only public immutable assets may use the download manager; authenticated endpoints are excluded.');
  }
  return JSON.stringify([manifest.id, manifest.version, manifest.sha256.toLowerCase(), manifest.bytes, url.href]);
}

const partKey = (id: string, n: number) => `download-part:${id}:${n}`;
const readyKey = (id: string) => `download-ready:${id}`;
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Download cancelled.', 'AbortError'); };
const strongEtag = (value: string | null) => value && /^"[^"\r\n]+"$/.test(value) ? value : null;

export class DownloadManager {
  private readonly fetcher: typeof fetch;
  private readonly maxBytes: number;
  private readonly checkpointBytes: number;
  constructor(private readonly store: OfflineStore, options: DownloadManagerOptions = {}) {
    if (!options.fetch && typeof globalThis.fetch !== 'function') throw new OfflineError('unavailable', 'Fetch is unavailable on this device.');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    this.checkpointBytes = options.checkpointBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0 || !Number.isSafeInteger(this.checkpointBytes) || this.checkpointBytes <= 0) {
      throw new OfflineError('invalid', 'Download byte limits must be positive integers.');
    }
  }
  async status(manifest: DownloadManifest): Promise<DownloadStatus | null> {
    manifest = Object.freeze({ ...manifest });
    const row = await this.store.read<DownloadRecord>('downloads', assetKey(manifest, this.maxBytes));
    return row ? { state: row.state, loaded: row.loaded, total: row.total } : null;
  }
  async get(manifest: DownloadManifest): Promise<Blob | null> {
    manifest = Object.freeze({ ...manifest });
    const id = assetKey(manifest, this.maxBytes);
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:${id}`, () => this.readReady(id, manifest), true));
  }
  private async verify(blob: Blob, manifest: DownloadManifest): Promise<void> {
    if (!globalThis.crypto?.subtle) throw new OfflineError('unavailable', 'SHA-256 verification requires a secure browser context.');
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
    this.store.assertAccess();
    if (blob.size !== manifest.bytes || hash !== manifest.sha256.toLowerCase()) throw new OfflineError('integrity', 'Downloaded bytes do not match the pinned model.');
  }
  private async readReady(id: string, manifest: DownloadManifest): Promise<Blob | null> {
    const row = await this.store.read<DownloadRecord>('downloads', id);
    if (row?.state !== 'ready') return null;
    const blob = await this.store.read<Blob>('blobs', readyKey(id));
    try {
      if (!blob) throw new OfflineError('integrity', 'The downloaded asset is missing.');
      await this.verify(blob, manifest);
      return blob;
    } catch (error) { await this.removeByKey(id); throw error; }
  }
  async remove(manifest: DownloadManifest): Promise<void> {
    manifest = Object.freeze({ ...manifest });
    const id = assetKey(manifest, this.maxBytes);
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:${id}`, () => this.removeByKey(id), true));
  }
  private removeByKey(id: string): Promise<void> {
    return this.store.transaction(['downloads', 'blobs'], 'readwrite', (tx, done) => {
      const request = tx.objectStore('downloads').get(id);
      request.onsuccess = () => {
        const row = request.result as DownloadRecord | undefined;
        for (let n = 0; n < (row?.chunks ?? 0); n++) tx.objectStore('blobs').delete(partKey(id, n));
        tx.objectStore('blobs').delete(readyKey(id)); tx.objectStore('downloads').delete(id); done(undefined);
      };
    });
  }
  async download(manifest: DownloadManifest, options: DownloadOptions = {}): Promise<Blob> {
    manifest = Object.freeze({ ...manifest });
    const id = assetKey(manifest, this.maxBytes);
    return this.store.runWork(() => offlineLock(`${this.store.databaseName}:${id}`, () => this.transfer(id, manifest, options), true, options.signal ? { signal: options.signal } : {}), options.signal);
  }
  private async transfer(id: string, manifest: DownloadManifest, options: DownloadOptions): Promise<Blob> {
    abort(options.signal);
    const cached = await this.readReady(id, manifest);
    if (cached) { abort(options.signal); options.onProgress?.({ loaded: cached.size, total: cached.size, resumed: false }); return cached; }
    let row = await this.store.read<DownloadRecord>('downloads', id);
    if (row && row.loaded < manifest.bytes && !row.etag) { await this.removeByKey(id); row = null; }
    let current: DownloadRecord = row ?? { state: 'partial', loaded: 0, total: manifest.bytes, chunks: 0, etag: null };
    let resumed = current.loaded > 0;
    let pending: BlobPart[] = [];
    let pendingBytes = 0;
    const checkpoint = async () => {
      if (!pendingBytes) return;
      const blob = new Blob(pending);
      const next = { ...current, loaded: current.loaded + pendingBytes, chunks: current.chunks + 1 };
      await this.store.transaction(['downloads', 'blobs'], 'readwrite', (tx, done) => {
        tx.objectStore('blobs').put(blob, partKey(id, current.chunks));
        tx.objectStore('downloads').put(next, id); done(undefined);
      });
      current = next; pending = []; pendingBytes = 0;
    };
    try {
      if (current.loaded < manifest.bytes) {
        const headers = new Headers();
        if (current.loaded && current.etag) { headers.set('Range', `bytes=${current.loaded}-`); headers.set('If-Range', current.etag); }
        const response = await this.fetcher(manifest.url, { headers, credentials: 'omit', redirect: 'error', cache: 'no-store', ...(options.signal ? { signal: options.signal } : {}) });
        if (response.status === 200 && current.loaded) {
          resumed = false; await this.removeByKey(id); current = { state: 'partial', loaded: 0, total: manifest.bytes, chunks: 0, etag: null };
        } else if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
          if (!current.loaded || !current.etag || strongEtag(response.headers.get('ETag')) !== current.etag || !range ||
              Number(range[1]) !== current.loaded || Number(range[2]) !== manifest.bytes - 1 || Number(range[3]) !== manifest.bytes) {
            await response.body?.cancel(); await this.removeByKey(id);
            throw new OfflineError('integrity', 'The resumed response does not match the saved asset version and range.');
          }
        } else if (response.status !== 200) {
          await response.body?.cancel(); throw new OfflineError('network', `Download failed with HTTP ${response.status}.`);
        }
        current.etag = strongEtag(response.headers.get('ETag'));
        if (!response.body) throw new OfflineError('network', 'Download has no response body.');
        const reader = response.body.getReader();
        try {
          for (;;) {
            abort(options.signal); this.store.assertAccess();
            const result = await reader.read();
            if (result.done) break;
            if (current.loaded + pendingBytes + result.value.byteLength > manifest.bytes) throw new OfflineError('integrity', 'Download exceeds its declared byte size.');
            // Store independent chunks, never rewrite the already downloaded prefix.
            pending.push(result.value.slice().buffer); pendingBytes += result.value.byteLength;
            if (pendingBytes >= this.checkpointBytes) await checkpoint();
            options.onProgress?.({ loaded: current.loaded + pendingBytes, total: manifest.bytes, resumed });
          }
          await checkpoint();
        } catch (error) {
          await reader.cancel().catch(() => {});
          if (!(error instanceof OfflineError && error.code === 'integrity')) await checkpoint();
          throw error;
        } finally { reader.releaseLock(); }
      }
      abort(options.signal);
      if (current.loaded !== manifest.bytes) throw new OfflineError('network', 'Download ended before the declared byte size. Retry to resume.');
      const parts: Blob[] = [];
      for (let n = 0; n < current.chunks; n++) {
        const part = await this.store.read<Blob>('blobs', partKey(id, n));
        if (!part) throw new OfflineError('integrity', 'A saved download chunk is missing.');
        parts.push(part);
      }
      const complete = new Blob(parts, { type: 'application/octet-stream' });
      await this.verify(complete, manifest); abort(options.signal);
      await this.store.transaction(['downloads', 'blobs'], 'readwrite', (tx, done) => {
        tx.objectStore('blobs').put(complete, readyKey(id));
        for (let n = 0; n < current.chunks; n++) tx.objectStore('blobs').delete(partKey(id, n));
        tx.objectStore('downloads').put({ ...current, state: 'ready', chunks: 0 }, id); done(undefined);
      });
      options.onProgress?.({ loaded: manifest.bytes, total: manifest.bytes, resumed });
      return complete;
    } catch (error) {
      if (error instanceof OfflineError && error.code === 'integrity') await this.removeByKey(id);
      throw error;
    }
  }
}

export function createDownloadManager(store: OfflineStore, options: DownloadManagerOptions = {}): DownloadManager { return new DownloadManager(store, options); }
