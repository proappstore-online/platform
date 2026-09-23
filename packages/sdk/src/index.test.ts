import { describe, it, expect, afterEach, vi } from 'vitest';
import { initPro, ProAppStore } from './index.js';

describe('initPro', () => {
  it('returns a ProAppStore with all modules', () => {
    const app = initPro({ appId: 'demo' });
    expect(app).toBeInstanceOf(ProAppStore);
    expect(app.auth).toBeDefined();
    expect(app.kv).toBeDefined();
    expect(app.counters).toBeDefined();
    expect(app.rooms).toBeDefined();
    expect(app.roles).toBeDefined();
    expect(app.proxy).toBeDefined();
    expect(app.subscription).toBeDefined();
    expect(app.license).toBeDefined();
    expect(app.notifications).toBeDefined();
    expect(app.actions).toBeDefined();
  });

  it('uses default API base when not specified', () => {
    const app = initPro({ appId: 'demo' });
    expect(app).toBeDefined();
  });

  it('accepts custom API base', () => {
    const app = initPro({ appId: 'demo', proApiBase: 'http://localhost:8788' });
    expect(app).toBeDefined();
  });
});

// #20: hosted pages default to platform-cookie via the host's meta marker;
// everything else stays legacy-bearer. Explicit options always win.
describe('initPro authMode default', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDocument(metaContent: string | null) {
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector === 'meta[name="pas-auth-mode"]' && metaContent !== null
          ? { getAttribute: (name: string) => (name === 'content' ? metaContent : null) }
          : null,
      ),
    });
  }

  it('is platform-cookie when the PAS host marker is present', () => {
    stubDocument('platform-cookie');
    expect(initPro({ appId: 'myapp' }).auth.usesPlatformCookie).toBe(true);
  });

  it('is legacy-bearer when there is no document (SSR, tests)', () => {
    expect(initPro({ appId: 'myapp' }).auth.usesPlatformCookie).toBe(false);
  });

  it('is legacy-bearer on a page without the marker (localhost, Pages-hosted sites)', () => {
    stubDocument(null);
    expect(initPro({ appId: 'myapp' }).auth.usesPlatformCookie).toBe(false);
  });

  it('ignores a marker with any other value', () => {
    stubDocument('legacy-bearer');
    expect(initPro({ appId: 'myapp' }).auth.usesPlatformCookie).toBe(false);
  });

  it('lets an explicit legacy-bearer override the marker', () => {
    stubDocument('platform-cookie');
    expect(initPro({ appId: 'myapp', authMode: 'legacy-bearer' }).auth.usesPlatformCookie).toBe(false);
  });

  it('lets an explicit platform-cookie work without the marker', () => {
    stubDocument(null);
    expect(initPro({ appId: 'myapp', authMode: 'platform-cookie' }).auth.usesPlatformCookie).toBe(true);
  });

  it('survives a document whose querySelector throws', () => {
    vi.stubGlobal('document', { querySelector: () => { throw new Error('nope'); } });
    expect(initPro({ appId: 'myapp' }).auth.usesPlatformCookie).toBe(false);
  });
});
