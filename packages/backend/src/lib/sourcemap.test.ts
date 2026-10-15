import { describe, expect, it } from 'vitest';
import { bundleProblem, framePath, parseStack, sha256Hex, sourcemapStorageKey, symbolicateStack, uploadSourceMap } from './sourcemap.js';

// #393: one release resolves only against its own maps; anything else is an
// explicit status with the frames left raw.

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
// Generated line 1, column 0 → src/App.tsx line 10 col 5 ("AASI"), or line 20 col 3 ("AAmBE").
const map = (mappings: string) => ({ version: 3, sources: ['src/App.tsx'], names: [], mappings });
const bundleBytes = (mappings: string, extra: Record<string, unknown> = {}) =>
  new TextEncoder().encode(JSON.stringify({ files: { 'assets/index-abc.js': map(mappings), ...extra } })).buffer as ArrayBuffer;
const frame = { source: 'https://chess-academy.proappstore.online/assets/index-abc.js?v=1', line: 1, col: 1 };

function fakeEnv() {
  const objects = new Map<string, ArrayBuffer>();
  const rows = new Map<string, { asset_digest: string; storage_key: string; expires_at: number; status: string }>();
  const env = {
    STORAGE: {
      put: async (k: string, v: ArrayBuffer) => { objects.set(k, v); },
      get: async (k: string) => (objects.has(k) ? { arrayBuffer: async () => objects.get(k)! } : null),
    } as unknown as R2Bucket,
    DB: { prepare: () => ({ bind: (app: string, sha: string) => ({ first: async () => rows.get(`${app}|${sha}`) ?? null }) }) } as unknown as D1Database,
  };
  const release = async (sha: string, bytes: ArrayBuffer, over: Partial<{ expires_at: number; status: string; digest: string }> = {}) => {
    const { storageKey, assetDigest } = await uploadSourceMap(env, 'chess-academy', sha, bytes);
    rows.set(`chess-academy|${sha}`, { asset_digest: over.digest ?? assetDigest, storage_key: storageKey, expires_at: over.expires_at ?? Date.now() + 60_000, status: over.status ?? 'active' });
  };
  return { env, objects, release };
}

describe('source-map releases (#393)', () => {
  it('two releases resolve the same minified position to their own original lines, never each other\'s', async () => {
    const { env, release } = fakeEnv();
    await release(SHA_A, bundleBytes('AASI'));
    await release(SHA_B, bundleBytes('AAmBE'));
    const a = await symbolicateStack(env, 'chess-academy', SHA_A, [frame]);
    const b = await symbolicateStack(env, 'chess-academy', SHA_B, [frame]);
    expect(a).toEqual({ status: 'ok', frames: [{ ...frame, originalSource: 'src/App.tsx', originalLine: 10, originalCol: 5 }] });
    expect(b.frames[0]).toMatchObject({ originalSource: 'src/App.tsx', originalLine: 20, originalCol: 3 });
  });

  it('no release → missing; expired or deleted → unavailable; altered bytes → mismatched — frames stay raw', async () => {
    const { env, objects, release } = fakeEnv();
    const raw = [{ ...frame, unresolved: true }];
    expect(await symbolicateStack(env, 'chess-academy', SHA_A, [frame])).toEqual({ status: 'missing', frames: raw });

    await release(SHA_A, bundleBytes('AASI'), { expires_at: Date.now() - 1 });
    expect((await symbolicateStack(env, 'chess-academy', SHA_A, [frame])).status).toBe('unavailable');

    await release(SHA_B, bundleBytes('AASI'));
    objects.delete(sourcemapStorageKey('chess-academy', SHA_B));
    expect((await symbolicateStack(env, 'chess-academy', SHA_B, [frame])).status).toBe('unavailable');

    const sha = 'c'.repeat(40);
    await release(sha, bundleBytes('AASI'), { digest: await sha256Hex(bundleBytes('AAmBE')) });
    expect(await symbolicateStack(env, 'chess-academy', sha, [frame])).toEqual({ status: 'mismatched', frames: raw });
  });

  it('a frame from a file the release has no map for stays raw and is marked unresolved; nothing is fetched', async () => {
    const { env, release } = fakeEnv();
    await release(SHA_A, bundleBytes('AASI'));
    const r = await symbolicateStack(env, 'chess-academy', SHA_A, [
      { source: 'https://evil.example/assets/index-abc.js.map', line: 1, col: 1 },
      { source: 'https://cdn.example/other.js', line: 1, col: 1 },
    ]);
    expect(r.status).toBe('ok');
    expect(r.frames.every((f) => f.unresolved)).toBe(true);
  });

  it('accepts only bounded, well-formed bundles with safe relative asset paths', () => {
    expect(bundleProblem(bundleBytes('AASI'))).toBeNull();
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer;
    expect(bundleProblem(new TextEncoder().encode('nope').buffer as ArrayBuffer)).toMatch(/not JSON/);
    expect(bundleProblem(enc({ files: {} }))).toMatch(/empty/);
    for (const bad of ['../secret.js', '/abs.js', 'a/../../b.js', 'https://x/y.js', 'a\\b.js', '']) {
      expect(bundleProblem(enc({ files: { [bad]: map('AASI') } })), bad).toMatch(/invalid asset path/);
    }
    expect(bundleProblem(enc({ files: { 'a.js': { version: 2, mappings: '' } } }))).toMatch(/not a v3/);
    expect(bundleProblem(enc({ files: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.js`, map('AASI')])) }))).toMatch(/more than 500/);
  });

  it('frame paths come from the URL path only', () => {
    expect(framePath('https://app.proappstore.online/assets/x.js?v=2#h')).toBe('assets/x.js');
    expect(framePath('/assets/x.js')).toBe('assets/x.js');
    expect(framePath('assets/x.js')).toBe('assets/x.js');
  });

  it('stores the bundle in the private bucket under _sourcemaps/, never an app prefix', async () => {
    const { env, objects } = fakeEnv();
    const { storageKey, assetDigest } = await uploadSourceMap(env, 'chess-academy', SHA_A, bundleBytes('AASI'));
    expect(storageKey).toBe(`_sourcemaps/chess-academy/${SHA_A}/bundle.json`);
    expect(assetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect([...objects.keys()]).toEqual([storageKey]);
  });

  it('parses V8 and Firefox/Safari stacks into bounded frames, skipping non-URL lines', () => {
    const v8 = 'TypeError: x\n    at onClick (https://a.example/assets/i.js:12:34)\n    at https://a.example/assets/j.js:1:2\n    at <anonymous>';
    expect(parseStack(v8)).toEqual([
      { source: 'https://a.example/assets/i.js', line: 12, col: 34 },
      { source: 'https://a.example/assets/j.js', line: 1, col: 2 },
    ]);
    expect(parseStack('onClick@https://a.example/assets/i.js:5:6\n@/assets/k.js:7:8')).toEqual([
      { source: 'https://a.example/assets/i.js', line: 5, col: 6 },
      { source: '/assets/k.js', line: 7, col: 8 },
    ]);
    expect(parseStack(Array.from({ length: 80 }, () => 'at f (https://a/x.js:1:1)').join('\n'))).toHaveLength(50);
  });
});
