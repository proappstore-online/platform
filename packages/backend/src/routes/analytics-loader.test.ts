import { describe, expect, it, vi } from 'vitest';
import { API_EVENT_URL, buildLoaderJs, SAME_ORIGIN_EVENT_URL } from './analytics-loader.js';

// #402: the loader's event URL, and its once-only delivery, run against a
// stubbed browser — the generated code is executed, not string-matched.

type Sent = { via: 'beacon' | 'fetch'; url: string; body: Record<string, unknown> };

function browser(opts: { beacon?: boolean | 'throws'; fetchFails?: boolean; online?: boolean } = {}) {
  const sent: Sent[] = [];
  const buffered: unknown[] = [];
  const listeners: Record<string, () => void> = {};
  const loc = { pathname: '/start' };
  const history = { pushState: (_s: unknown, _t: string, url: string) => { loc.pathname = url.split(/[?#]/)[0]!; }, replaceState: (_s: unknown, _t: string, url: string) => { loc.pathname = url.split(/[?#]/)[0]!; } };
  const store = { count: () => { const r: { result: number; onsuccess?: () => void } = { result: buffered.length }; queueMicrotask(() => r.onsuccess?.()); return r; }, add: (e: unknown) => { buffered.push(e); }, getAll: () => { const r: { result: unknown[]; onsuccess?: () => void } = { result: [] }; queueMicrotask(() => r.onsuccess?.()); return r; } };
  const db = { transaction: () => ({ objectStore: () => store }) };
  const indexedDB = { open: () => { const r: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
  const navigator = {
    onLine: opts.online ?? true,
    sendBeacon: opts.beacon === undefined ? undefined : (url: string, body: string) => {
      if (opts.beacon === 'throws') throw new Error('blocked');
      if (opts.beacon) sent.push({ via: 'beacon', url, body: JSON.parse(body) });
      return opts.beacon;
    },
  };
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    if (opts.fetchFails) throw new TypeError('Failed to fetch');
    sent.push({ via: 'fetch', url, body: JSON.parse(init.body) });
    return { ok: true };
  });
  const window = { addEventListener: (e: string, f: () => void) => { listeners[e] = f; } } as Record<string, unknown>;
  const document = { referrer: '', head: { appendChild: () => {} }, createElement: () => ({ setAttribute: () => {} }) };
  return { sent, buffered, listeners, loc, history, run: (js: string) => new Function('window', 'document', 'navigator', 'location', 'history', 'indexedDB', 'fetch', js)(window, document, navigator, loc, history, indexedDB, fetch), window, fetch };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('analytics loader (#402)', () => {
  it('posts to the API for external sites and same-origin when the host serves it', () => {
    expect(buildLoaderJs(null, 'myapp')).toContain(JSON.stringify(API_EVENT_URL));
    const same = buildLoaderJs(null, 'myapp', SAME_ORIGIN_EVENT_URL);
    expect(same).toContain('"/.pas/analytics/event"');
    expect(same).not.toContain('api.proappstore.online');
  });

  it('a queued beacon is the only send: no fetch, no buffer', async () => {
    const b = browser({ beacon: true });
    b.run(buildLoaderJs(null, 'myapp', SAME_ORIGIN_EVENT_URL));
    await flush();
    expect(b.sent).toEqual([{ via: 'beacon', url: '/.pas/analytics/event', body: expect.objectContaining({ app: 'myapp', kind: 'pageview', path: '/start' }) }]);
    expect(b.fetch).not.toHaveBeenCalled();
    expect(b.buffered).toEqual([]);
  });

  it('a refused or throwing beacon falls back to one fetch; only a failed fetch is buffered', async () => {
    for (const beacon of [false, 'throws'] as const) {
      const b = browser({ beacon });
      b.run(buildLoaderJs(null, 'myapp'));
      await flush();
      expect(b.sent.map((s) => s.via)).toEqual(['fetch']);
      expect(b.buffered).toEqual([]);
    }
    const down = browser({ beacon: false, fetchFails: true });
    down.run(buildLoaderJs(null, 'myapp'));
    await flush(); await flush();
    expect(down.sent).toEqual([]);
    expect(down.buffered).toHaveLength(1);
  });

  it('a pageview is a path change: same-path replaceState, query and hash changes are not new pages', async () => {
    const b = browser({ beacon: true });
    b.run(buildLoaderJs(null, 'myapp'));
    b.history.replaceState(null, '', '/start?tab=2');
    b.history.replaceState(null, '', '/start#x');
    b.history.pushState(null, '', '/clubs');
    b.history.pushState(null, '', '/clubs');
    b.loc.pathname = '/start';
    b.listeners.popstate?.();
    (b.window.pasAnalytics as { event: (k: string) => void }).event('signup');
    await flush();
    expect(b.sent.map((s) => [s.body.kind, s.body.path])).toEqual([
      ['pageview', '/start'], ['pageview', '/clubs'], ['pageview', '/start'], ['signup', '/start'],
    ]);
  });
});
