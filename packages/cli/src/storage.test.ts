import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #515: `pas storage import <dir>` uploads every file under <dir> through the
// EXISTING `PUT /v1/apps/:appId/storage/*` route, one file at a time, and
// prints a path -> key manifest.

vi.mock('./lib/config.js', () => ({
  readConfig: async () => ({ apiBase: 'https://api.test', session: { token: 'tok' } }),
}));

const { importStorage } = await import('./storage.js');

let dir: string;
let calls: { url: string; method: string; headers: Headers; body: Uint8Array }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pas-storage-import-'));
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? 'GET', headers, body: new Uint8Array(init.body as ArrayBuffer) });
    const key = decodeURIComponent(new URL(url).pathname.split('/storage/')[1]!);
    return Response.json({ key, size: (init.body as ArrayBuffer).byteLength, contentType: headers.get('Content-Type'), url: `/v1/apps/x/storage/${key}` }, { status: 200 });
  }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('importStorage', () => {
  it('uploads every file under the directory, recursively, under _public/', async () => {
    writeFileSync(join(dir, 'floor1.png'), 'png-bytes');
    mkdirSync(join(dir, 'mall-a'));
    writeFileSync(join(dir, 'mall-a', 'floor2.png'), 'png-bytes-2');

    const manifest = await importStorage({ dir, app: 'test-app' });

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'PUT')).toBe(true);
    expect(calls.every((c) => c.headers.get('Authorization') === 'Bearer tok')).toBe(true);
    expect(manifest.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'floor1.png', key: '_public/floor1.png', size: 9 },
      { path: 'mall-a/floor2.png', key: '_public/mall-a/floor2.png', size: 11 },
    ]);
  });

  it('applies --prefix under _public/', async () => {
    writeFileSync(join(dir, 'a.png'), 'x');
    const manifest = await importStorage({ dir, app: 'test-app', prefix: 'mallguide' });
    expect(manifest[0]!.key).toBe('_public/mallguide/a.png');
    expect(calls[0]!.url).toContain('/storage/_public/mallguide/a.png');
  });

  it('sets Content-Type from the file extension', async () => {
    writeFileSync(join(dir, 'a.png'), 'x');
    writeFileSync(join(dir, 'b.bin'), 'x');
    await importStorage({ dir, app: 'test-app' });
    const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.headers.get('Content-Type')]));
    expect(byUrl[Object.keys(byUrl).find((u) => u.endsWith('a.png'))!]).toBe('image/png');
    expect(byUrl[Object.keys(byUrl).find((u) => u.endsWith('b.bin'))!]).toBe('application/octet-stream');
  });

  it('refuses an empty directory', async () => {
    await expect(importStorage({ dir, app: 'test-app' })).rejects.toThrow('no files found');
  });
});
