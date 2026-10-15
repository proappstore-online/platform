import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBundle, findSourceMaps, MAX_BUNDLE_BYTES, oidcToken, sourcemapsCommand, stripSourceMaps, uploadSourceMaps } from './sourcemaps.js';

// #393: one private release bundle per commit, verified against the platform's
// manifest digest, keyless, and the maps never left in the build afterwards.

const SHA = 'a'.repeat(40);
const map = { version: 3, sources: ['src/App.tsx'], names: [], mappings: 'AASI' };

function build(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pas-maps-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'assets/index-abc.js'), 'x()');
  writeFileSync(join(dir, 'assets/index-abc.js.map'), JSON.stringify(map));
  writeFileSync(join(dir, 'assets/vendor-1.js.map'), JSON.stringify(map));
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c);
  return dir;
}
const digestOf = (dir: string) => createHash('sha256').update(buildBundle(dir).body).digest('hex');

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('pas sourcemaps upload (#393)', () => {
  it('sends one bundle keyed by asset path to the release endpoint, with the OIDC bearer, and verifies the digest', async () => {
    const dir = build();
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init! });
      return Response.json({ assetDigest: digestOf(dir), expiresAt: 123 }, { status: 201 });
    }) as unknown as typeof fetch;
    const out = await uploadSourceMaps({ dir, appId: 'map-demo', commitSha: SHA, token: 'oidc-jwt', apiBase: 'https://api.test', fetchImpl });
    expect(out).toEqual({ status: 'uploaded', count: 2, digest: digestOf(dir), expiresAt: 123 });
    expect(sent[0]!.url).toBe(`https://api.test/v1/apps/map-demo/sourcemaps?commitSha=${SHA}`);
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer oidc-jwt');
    expect(Object.keys(JSON.parse(String(sent[0]!.init.body)).files)).toEqual(['assets/index-abc.js', 'assets/vendor-1.js']);
  });

  it('a digest the platform did not record for these bytes is an error; a 409 is an existing immutable release', async () => {
    const dir = build();
    const wrong = vi.fn(async () => Response.json({ assetDigest: 'f'.repeat(64) }, { status: 201 })) as unknown as typeof fetch;
    await expect(uploadSourceMaps({ dir, appId: 'map-demo', commitSha: SHA, token: 't', fetchImpl: wrong })).rejects.toThrow(/does not match/);
    const exists = vi.fn(async () => new Response(null, { status: 409 })) as unknown as typeof fetch;
    expect((await uploadSourceMaps({ dir, appId: 'map-demo', commitSha: SHA, token: 't', fetchImpl: exists })).status).toBe('exists');
  });

  it('refuses before uploading: oversized maps, non-JSON maps, no maps, a bad commit', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const big = build({ 'huge.js.map': 'x'.repeat(MAX_BUNDLE_BYTES + 1) });
    await expect(uploadSourceMaps({ dir: big, appId: 'a', commitSha: SHA, token: 't', fetchImpl })).rejects.toThrow(/exceed/);
    const bad = build({ 'bad.js.map': 'not json' });
    await expect(uploadSourceMaps({ dir: bad, appId: 'a', commitSha: SHA, token: 't', fetchImpl })).rejects.toThrow(/not a JSON source map/);
    const none = mkdtempSync(join(tmpdir(), 'pas-maps-'));
    await expect(uploadSourceMaps({ dir: none, appId: 'a', commitSha: SHA, token: 't', fetchImpl })).rejects.toThrow(/no \*\.map files/);
    await expect(uploadSourceMaps({ dir: build(), appId: 'a', commitSha: 'main', token: 't', fetchImpl })).rejects.toThrow(/40-character/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stripSourceMaps removes every map and nothing else', () => {
    const dir = build();
    expect(stripSourceMaps(dir)).toBe(2);
    expect(findSourceMaps(dir)).toEqual([]);
    expect(existsSync(join(dir, 'assets/index-abc.js'))).toBe(true);
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
  });

  it('is keyless: uses PAS_OIDC_TOKEN or mints from the Actions runtime; refuses with neither', async () => {
    expect(await oidcToken({ PAS_OIDC_TOKEN: 'jwt' })).toBe('jwt');
    const fetchImpl = vi.fn(async () => Response.json({ value: 'minted' })) as unknown as typeof fetch;
    expect(await oidcToken({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.test/token?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'rt' }, fetchImpl)).toBe('minted');
    expect((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe('https://gh.test/token?x=1&audience=https%3A%2F%2Fapi.proappstore.online');
    await expect(oidcToken({})).rejects.toThrow(/GitHub Actions/);
  });

  it('the command exits non-zero on a refused upload and still strips the maps from the build', async () => {
    const dir = build();
    vi.stubEnv('PAS_OIDC_TOKEN', 'jwt');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'repository not authorized' }, { status: 403 }));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await sourcemapsCommand.parseAsync(['upload', '--dir', dir, '--app', 'map-demo', '--commit', SHA], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]![0])).toContain('upload refused (HTTP 403)');
    expect(findSourceMaps(dir)).toEqual([]);
    vi.unstubAllEnvs();
  });
});
