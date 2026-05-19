import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLive,
  checkBrandFontsLive,
  checkBundleSizeLive,
  checkManifestLive,
  checkNoTrackingLive,
  checkUnsafeVhLive,
} from './index.js';

/** Incompressible random bytes — gzipping these yields ≈ same size,
 *  unlike all-zero buffers which compress to a few bytes. */
function randomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

describe('checkNoTrackingLive', () => {
  it('passes when HTML is clean of tracker patterns', () => {
    const r = checkNoTrackingLive('<html><body>hello</body></html>');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/no known trackers/);
  });

  it('flags Google Analytics', () => {
    const r = checkNoTrackingLive('<script src="https://google-analytics.com/ga.js"></script>');
    expect(r.status).toBe('fail');
    expect(r.suggestions?.[0]).toMatch(/Tracking was injected/);
  });

  it('flags Plausible, Mixpanel, Hotjar variants', () => {
    expect(checkNoTrackingLive('<script src="https://plausible.io/script.js">').status).toBe(
      'fail',
    );
    expect(checkNoTrackingLive('<div>amplitude tracker</div>').status).toBe('fail');
    expect(checkNoTrackingLive('<script>gtag("event")</script>').status).toBe('fail');
    expect(
      checkNoTrackingLive('<script src="https://www.googletagmanager.com/gtm.js">').status,
    ).toBe('fail');
    expect(checkNoTrackingLive('<script src="//cdn.mixpanel.com/x">').status).toBe('fail');
    expect(checkNoTrackingLive('<script src="https://static.hotjar.com/c/hotjar.js">').status).toBe(
      'fail',
    );
    expect(checkNoTrackingLive('<script src="https://posthog.com/array.js">').status).toBe('fail');
  });
});

describe('checkBrandFontsLive', () => {
  it('passes when both Manrope and Fraunces are referenced', () => {
    const r = checkBrandFontsLive(
      '<link href="https://fonts.googleapis.com/css2?family=Manrope&family=Fraunces" rel="stylesheet">',
    );
    expect(r.status).toBe('pass');
  });

  it('matches case-insensitively', () => {
    const r = checkBrandFontsLive('<style>font-family: manrope, fraunces</style>');
    expect(r.status).toBe('pass');
  });

  it('fails when one or both fonts are missing', () => {
    const r1 = checkBrandFontsLive('<link href="...?family=Manrope">');
    expect(r1.status).toBe('fail');
    expect(r1.detail).toMatch(/Fraunces/);
    const r2 = checkBrandFontsLive('<head></head>');
    expect(r2.status).toBe('fail');
    expect(r2.detail).toMatch(/Manrope.*Fraunces/);
  });
});

describe('checkManifestLive', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails when no <link rel="manifest"> in HTML', async () => {
    const r = await checkManifestLive('<html><head></head></html>', 'https://x.example');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/no <link rel="manifest"/);
  });

  it('fails when manifest fetch returns non-2xx', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 404 }),
    );
    const html = '<link rel="manifest" href="/manifest.json">';
    const r = await checkManifestLive(html, 'https://x.example');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/404/);
  });

  it('fails when manifest is missing required fields', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ name: 'X' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const html = '<link rel="manifest" href="/manifest.json">';
    const r = await checkManifestLive(html, 'https://x.example');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/display.*start_url|start_url.*display/);
  });

  it('passes when manifest has all required fields', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ name: 'X', display: 'standalone', start_url: '/' }), {
        status: 200,
      }),
    );
    const html = '<link rel="manifest" href="/manifest.json">';
    const r = await checkManifestLive(html, 'https://x.example');
    expect(r.status).toBe('pass');
  });

  it('resolves manifest URL relative to liveUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'X', display: 'standalone', start_url: '/' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);
    const html = '<link rel="manifest" href="manifest.json">';
    await checkManifestLive(html, 'https://app.example/');
    // First arg is the URL — should resolve to absolute.
    expect(mockFetch).toHaveBeenCalledWith('https://app.example/manifest.json', expect.any(Object));
  });
});

describe('checkBundleSizeLive', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns warn when no /assets/*.js found (non-Vite layout)', async () => {
    const r = await checkBundleSizeLive('<html><body></body></html>', 'https://x.example');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/non-Vite/);
  });

  it('passes when bundle is comfortably under 300 KB gzipped', async () => {
    // 200 KB of incompressible random bytes → gzip ≈ 200 KB, well under.
    const small = randomBytes(200_000);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(small.buffer as ArrayBuffer, { status: 200 }),
    );
    const html = '<script src="/assets/index-abc.js"></script>';
    const r = await checkBundleSizeLive(html, 'https://x.example');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/KB gzipped/);
  });

  it('fails when real gzipped bundle exceeds 300 KB', async () => {
    // 500 KB of incompressible random bytes → gzip ≈ 500 KB, over the
    // 300 KB limit. Earlier this test used an all-zeros buffer that
    // gzipped to ~1.5 KB but was assumed to fail via the old divide-
    // by-3.5 approximation. With real gzip, content matters.
    const large = randomBytes(500_000);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(large.buffer as ArrayBuffer, { status: 200 }),
    );
    const html = '<script src="/assets/index-big.js"></script>';
    const r = await checkBundleSizeLive(html, 'https://x.example');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/over 300 KB/);
  });
});

describe('auditLive (integration)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns reachable=false + a single fail check when fetch errors', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await auditLive({ appId: 'tip', liveUrl: 'https://tip.example' });
    expect(r.reachable).toBe(false);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.status).toBe('fail');
    expect(r.results[0]!.name).toBe('Reachable');
  });

  it('returns reachable=false + fail when origin returns 5xx', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('boom', { status: 503 }),
    );
    const r = await auditLive({ appId: 'tip', liveUrl: 'https://tip.example' });
    expect(r.reachable).toBe(false);
    expect(r.results[0]!.detail).toMatch(/HTTP 503/);
  });

  it('runs all 5 checks when origin is reachable', async () => {
    const html = `
      <html><head>
        <link href="https://fonts.googleapis.com/css2?family=Manrope&family=Fraunces" rel="stylesheet">
        <link rel="stylesheet" href="/assets/index-abc.css">
        <link rel="manifest" href="/manifest.json">
      </head><body>
        <script src="/assets/index-abc.js"></script>
      </body></html>
    `;
    let callCount = 0;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) return new Response(html, { status: 200 });
      if (url.endsWith('/manifest.json')) {
        return new Response(
          JSON.stringify({ name: 'tip', display: 'standalone', start_url: '/' }),
          { status: 200 },
        );
      }
      if (url.endsWith('.css')) {
        return new Response('body { height: 100svh; }', { status: 200 });
      }
      // bundle: small size → pass
      return new Response(new ArrayBuffer(150_000), { status: 200 });
    });
    const r = await auditLive({ appId: 'tip', liveUrl: 'https://tip.example' });
    expect(r.reachable).toBe(true);
    // 6 results: Reachable + tracking + fonts + manifest + bundle + vh.
    // Reachable is recorded on success too so stale fail rows from
    // earlier runs get overwritten on the next clean pass.
    expect(r.results).toHaveLength(6);
    const reachable = r.results.find((c) => c.name === 'Reachable');
    expect(reachable?.status).toBe('pass');
    const otherStatuses = r.results.filter((c) => c.name !== 'Reachable').map((c) => c.status);
    expect(otherStatuses).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
  });

  it("downgrades subrequest-cap errors from fail → warn (not the app's fault)", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Too many subrequests by single Worker invocation.'),
    );
    const r = await auditLive({ appId: 'tip', liveUrl: 'https://tip.example' });
    expect(r.reachable).toBe(false);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.name).toBe('Reachable');
    expect(r.results[0]!.status).toBe('warn');
    expect(r.results[0]!.detail).toMatch(/subrequest cap/);
  });

  it('stamps checkedAt and preserves appId', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'));
    const before = Date.now();
    const r = await auditLive({ appId: 'my-app', liveUrl: 'https://my.example' });
    const after = Date.now();
    expect(r.appId).toBe('my-app');
    expect(r.liveUrl).toBe('https://my.example');
    expect(r.checkedAt).toBeGreaterThanOrEqual(before);
    expect(r.checkedAt).toBeLessThanOrEqual(after);
  });
});

describe('checkUnsafeVhLive', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warns when no <link rel="stylesheet"> exists in HTML', async () => {
    const r = await checkUnsafeVhLive('<html><body></body></html>', 'https://x.example');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no.*stylesheet/);
  });

  it('finds the stylesheet href regardless of attribute order (rel before href)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('body { height: 100svh; }', { status: 200 }),
    );
    const html = '<link rel="stylesheet" href="/assets/index.css">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('pass');
  });

  it('finds the stylesheet href regardless of attribute order (href before rel)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('body { height: 100svh; }', { status: 200 }),
    );
    const html = '<link href="/assets/index.css" rel="stylesheet">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('pass');
  });

  it('warns when CSS contains 100vh', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('.full { height: 100vh; padding: 100vh; }', { status: 200 }),
    );
    const html = '<link rel="stylesheet" href="/assets/index.css">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/2 occurrence\(s\) of 100vh/);
    expect(r.suggestions?.join('\n')).toMatch(/100svh.*100dvh/);
  });

  it('passes when CSS uses 100svh / 100dvh exclusively', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('a{height:100svh}b{height:100dvh}', { status: 200 }),
    );
    const html = '<link rel="stylesheet" href="/assets/index.css">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('pass');
  });

  it('does not match identifier-like substrings (word boundary on the unit)', async () => {
    // `--my100vhvar` and `var100vh1` aren't actual unit usage; the
    // word-boundary anchors on the regex literal must keep us from
    // flagging them.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('.x { --my100vhvar: 0; } .y { content: "var100vh1"; }', { status: 200 }),
    );
    const html = '<link rel="stylesheet" href="/assets/index.css">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('pass');
  });

  it('warns (not fail) on subrequest cap errors so audit-Worker noise does not flip badges', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Too many subrequests by single Worker invocation'),
    );
    const html = '<link rel="stylesheet" href="/assets/index.css">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/subrequest cap/);
  });

  it('warns on non-200 CSS fetch response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 404 }),
    );
    const html = '<link rel="stylesheet" href="/assets/index.css">';
    const r = await checkUnsafeVhLive(html, 'https://x.example');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/HTTP 404/);
  });
});
