import { describe, expect, it } from 'vitest';
import { MANIFEST_FILE, parseArtifactManifest, servablePath, sha256Hex, verifyStoredArtifact } from './marketing-artifact.js';

// #399: the storefront build's artifact manifest, and re-verification of a stored artifact.

const enc = (s: string) => new TextEncoder().encode(s);
async function manifestFor(files: Record<string, string>, over: Record<string, unknown> = {}) {
  const types: Record<string, string> = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', css: 'text/css; charset=utf-8' };
  const list = [];
  for (const [path, body] of Object.entries(files)) list.push({ path, contentType: types[path.split('.').pop()!], size: enc(body).length, sha256: await sha256Hex(enc(body)) });
  return { schemaVersion: 1, appId: 'shop', revision: 'rev-1', preview: false, origin: 'https://about-shop.proappstore.online', files: list, ...over };
}
const SITE = { '/index.html': '<h1>x</h1>', '/robots.txt': 'User-agent: *', '/sitemap.xml': '<urlset/>', '/_astro/site.css': 'h1{}' };

describe('servablePath (#399)', () => {
  it('accepts exactly what the marketing host serves', () => {
    for (const ok of ['/index.html', '/robots.txt', '/sitemap.xml', '/_astro/a.b1c.css', '/assets/hero.webp', '/assets/img/a.png']) expect(servablePath(ok), ok).toBe(true);
    for (const bad of ['/', '/other.html', '/assets/page.html', '/assets/a.js.map', '/assets/../x.png', '/assets/./x.png', '/assets/.env', '/assets//x.png',
      '/artifact-manifest.json', 'index.html', '/assets/x%2e.png', `/assets/${'a'.repeat(200)}.png`]) expect(servablePath(bad), bad).toBe(false);
  });
});

describe('parseArtifactManifest (#399)', () => {
  it('accepts the storefront build manifest', async () => {
    const m = parseArtifactManifest(JSON.stringify(await manifestFor(SITE)), 'shop', 'rev-1');
    expect(typeof m === 'object' && m.files.map((f) => f.path)).toEqual(Object.keys(SITE));
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
  ])('refuses %s', (_n, text) => expect(typeof parseArtifactManifest(text, 'shop', 'rev-1')).toBe('string'));

  it('refuses every field that does not bind it to this app, revision and live origin', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ schemaVersion: 2 }, /schemaVersion/],
      [{ appId: 'rival' }, /appId/],
      [{ revision: 'rev-2' }, /revision/],
      [{ preview: true }, /preview/],
      [{ origin: 'https://about-rival.proappstore.online' }, /origin/],
      [{ files: [] }, /no files/],
      [{ files: Array.from({ length: 201 }, () => ({})) }, /at most/],
    ];
    for (const [over, problem] of cases) expect(parseArtifactManifest(JSON.stringify(await manifestFor(SITE, over)), 'shop', 'rev-1')).toMatch(problem);
    expect(parseArtifactManifest('x'.repeat(300 * 1024), 'shop', 'rev-1')).toMatch(/too large/);
  });

  it('refuses unservable, duplicate, mistyped, oversized or unhashed files and a missing required file', async () => {
    const base = await manifestFor(SITE);
    const withFile = (patch: Record<string, unknown>) => JSON.stringify({ ...base, files: [...base.files, { ...base.files[3], ...patch }] });
    expect(parseArtifactManifest(withFile({ path: '/assets/app.js.map' }), 'shop', 'rev-1')).toMatch(/publishable/);
    expect(parseArtifactManifest(withFile({}), 'shop', 'rev-1')).toMatch(/duplicate/);
    expect(parseArtifactManifest(withFile({ path: '/assets/x.css', contentType: 'text/html; charset=utf-8' }), 'shop', 'rev-1')).toMatch(/content type/);
    expect(parseArtifactManifest(withFile({ path: '/assets/x.js', contentType: 'application/javascript' }), 'shop', 'rev-1')).toMatch(/content type/);
    expect(parseArtifactManifest(withFile({ path: '/assets/x.css', size: 11 * 1024 * 1024 }), 'shop', 'rev-1')).toMatch(/size/);
    expect(parseArtifactManifest(withFile({ path: '/assets/x.css', size: 1.5 }), 'shop', 'rev-1')).toMatch(/size/);
    expect(parseArtifactManifest(withFile({ path: '/assets/x.css', sha256: 'ABC' }), 'shop', 'rev-1')).toMatch(/sha256/);
    const big = Array.from({ length: 4 }, (_, i) => ({ ...base.files[3], path: `/assets/big${i}.css`, size: 9 * 1024 * 1024 }));
    expect(parseArtifactManifest(JSON.stringify({ ...base, files: [...base.files, ...big] }), 'shop', 'rev-1')).toMatch(/artifact too large/);
    const noRobots = await manifestFor({ '/index.html': 'x', '/sitemap.xml': 'y' });
    expect(parseArtifactManifest(JSON.stringify(noRobots), 'shop', 'rev-1')).toMatch(/robots\.txt/);
  });
});

describe('verifyStoredArtifact (#399)', () => {
  async function stored(files: Record<string, string>) {
    const manifestText = JSON.stringify(await manifestFor(files));
    const objects = new Map<string, Uint8Array>(Object.entries(files).map(([p, b]) => [`marketing/shop/revisions/rev-1${p}`, enc(b)]));
    objects.set(`marketing/shop/revisions/rev-1/${MANIFEST_FILE}`, enc(manifestText));
    const bucket = { get: async (k: string) => { const b = objects.get(k); return b ? { arrayBuffer: async () => b.slice().buffer } : null; } } as unknown as R2Bucket;
    return { bucket, objects, sha: await sha256Hex(enc(manifestText)) };
  }

  it('passes an intact artifact', async () => {
    const { bucket, sha } = await stored(SITE);
    expect(await verifyStoredArtifact(bucket, 'shop', 'rev-1', sha)).toBeNull();
  });

  it('names what is missing or changed', async () => {
    let s = await stored(SITE);
    expect(await verifyStoredArtifact(s.bucket, 'shop', 'rev-1', 'f'.repeat(64))).toMatch(/manifest was changed/);
    s.objects.delete('marketing/shop/revisions/rev-1/_astro/site.css');
    expect(await verifyStoredArtifact(s.bucket, 'shop', 'rev-1', s.sha)).toMatch(/missing: \/_astro\/site\.css/);
    s = await stored(SITE);
    s.objects.set('marketing/shop/revisions/rev-1/index.html', enc('<h1>y</h1>'));
    expect(await verifyStoredArtifact(s.bucket, 'shop', 'rev-1', s.sha)).toMatch(/does not match/);
    s.objects.delete(`marketing/shop/revisions/rev-1/${MANIFEST_FILE}`);
    expect(await verifyStoredArtifact(s.bucket, 'shop', 'rev-1', s.sha)).toMatch(/manifest is missing/);
    // A stored manifest for another revision fails its own binding.
    s = await stored(SITE);
    expect(await verifyStoredArtifact(s.bucket, 'shop', 'rev-2', s.sha)).toMatch(/missing/);
    // A stored manifest whose bytes match but whose content no longer validates.
    const wrong = enc(JSON.stringify(await manifestFor(SITE, { revision: 'rev-9' })));
    s.objects.set(`marketing/shop/revisions/rev-1/${MANIFEST_FILE}`, wrong);
    expect(await verifyStoredArtifact(s.bucket, 'shop', 'rev-1', await sha256Hex(wrong))).toMatch(/revision/);
  });
});
