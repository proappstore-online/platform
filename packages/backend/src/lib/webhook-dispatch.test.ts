import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { dispatchWebhook, MAX_WEBHOOKS_PER_APP, WEBHOOK_TIMEOUT_MS, retryDueDeliveries, MAX_DELIVERY_ATTEMPTS } = await import('./webhook-dispatch.js');

function fakeDb(hooks: { id: string; url: string; secret: string }[] = []) {
  const deliveries: { id: string; webhook_id: string; event: string; status: number | null }[] = [];
  return {
    deliveries,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: hooks }),
        run: async () => {
          if (sql.includes('INSERT INTO webhook_deliveries')) {
            deliveries.push({
              id: args[0] as string,
              webhook_id: args[1] as string,
              event: args[2] as string,
              status: args[4] as number | null,
            });
          }
        },
      }),
    }),
  } as unknown as D1Database;
}

// Block body: returning the mock would make vitest call it as a cleanup hook.
beforeEach(() => { mockFetch.mockReset(); });

describe('dispatchWebhook', () => {
  it('does nothing when no hooks are registered', async () => {
    const db = fakeDb([]);
    await dispatchWebhook(db, 'app1', 'notification.sent', { id: '1' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('dispatch is bounded at MAX_WEBHOOKS_PER_APP hooks, oldest first (#27)', async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ all: async () => ({ results: [] }), run: async () => ({}) })),
      sql,
    }));
    await dispatchWebhook({ prepare } as unknown as D1Database, 'app1', 'storage.uploaded', {});
    const select = prepare.mock.results[0]!.value as { sql: string; bind: ReturnType<typeof vi.fn> };
    expect(select.sql).toMatch(/ORDER BY created_at, id LIMIT \?3/);
    expect(select.bind).toHaveBeenCalledWith('app1', 'storage.uploaded', MAX_WEBHOOKS_PER_APP);
  });

  it('delivers to registered hooks with HMAC signature', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 } as Response);
    const db = fakeDb([{ id: 'h1', url: 'https://example.com/hook', secret: 'whsec_test' }]);

    await dispatchWebhook(db, 'app1', 'storage.uploaded', { key: 'file.jpg' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Webhook-Event']).toBe('storage.uploaded');
    expect(headers['Content-Type']).toBe('application/json');

    const body = init.body as string;
    expect(JSON.parse(body).key).toBe('file.jpg');

    // Verify HMAC is correct (not just the right length)
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('whsec_test'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expectedSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const expectedHex = Array.from(new Uint8Array(expectedSig)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(headers['X-Webhook-Signature']).toBe(expectedHex);
  });

  it('asserts webhook_id is correctly captured in delivery log', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 } as Response);
    const db = fakeDb([{ id: 'hook-42', url: 'https://example.com/hook', secret: 's' }]);
    await dispatchWebhook(db, 'app1', 'test', {});
    expect(db.deliveries[0]!.webhook_id).toBe('hook-42');
  });

  it('logs delivery with status code', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 } as Response);
    const db = fakeDb([{ id: 'h1', url: 'https://example.com/hook', secret: 's' }]);
    await dispatchWebhook(db, 'app1', 'test', { x: 1 });
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0]!.status).toBe(200);
    expect(db.deliveries[0]!.event).toBe('test');
  });

  it('logs null status on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const db = fakeDb([{ id: 'h1', url: 'https://example.com/hook', secret: 's' }]);
    await dispatchWebhook(db, 'app1', 'test', {});
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0]!.status).toBeNull();
  });

  it('delivers to multiple hooks independently (Promise.allSettled)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200 } as Response);
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    const db = fakeDb([
      { id: 'h1', url: 'https://a.com/hook', secret: 's1' },
      { id: 'h2', url: 'https://b.com/hook', secret: 's2' },
    ]);
    await dispatchWebhook(db, 'app1', 'test', {});
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(db.deliveries).toHaveLength(2);
    expect(db.deliveries[0]!.status).toBe(200);
    expect(db.deliveries[1]!.status).toBeNull();
  });
});

// #224: never follow a redirect past the registration-time SSRF guard, and never
// let a hung receiver stall the caller.
describe('dispatchWebhook hardening (#224)', () => {
  const hook = { id: 'h1', url: 'https://example.com/hook', secret: 'whsec_secret_value' };
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  it('does not follow redirects: a 302 to an internal host is recorded, not re-POSTed', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/admin' } }));
    const db = fakeDb([hook]);
    await dispatchWebhook(db, 'app1', 'test', { x: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
    expect(db.deliveries[0]!.status).toBe(302);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      event: 'webhook_delivery_failed', app_id: 'app1', webhook_id: 'h1', webhook_event: 'test', status: 302,
    });
  });

  it('bounds each delivery with a timeout signal', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok'));
    await dispatchWebhook(fakeDb([hook]), 'app1', 'test', {});
    const init = (mockFetch.mock.calls[0] as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  it('a hung receiver is aborted and recorded as null; the other hooks still deliver', async () => {
    // The timeout signal is driven by hand: fire it as AbortSignal.timeout would.
    const timeouts: AbortController[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      expect(ms).toBe(WEBHOOK_TIMEOUT_MS);
      const ac = new AbortController();
      timeouts.push(ac);
      return ac.signal;
    });
    try {
      let hungSignal: AbortSignal | undefined;
      mockFetch.mockImplementation((url: string, init: RequestInit) => {
        if (url.includes('hung')) {
          hungSignal = init.signal!;
          return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
        }
        return Promise.resolve(new Response('ok'));
      });
      const db = fakeDb([{ ...hook, id: 'hung', url: 'https://hung.example/hook' }, { ...hook, id: 'ok', url: 'https://ok.example/hook' }]);
      const done = dispatchWebhook(db, 'app1', 'test', {});
      // Hooks sign in parallel, so the timeouts are created in no fixed order:
      // abort the one the hung fetch actually received.
      await vi.waitFor(() => { expect(timeouts).toHaveLength(2); expect(hungSignal).toBeDefined(); });
      timeouts.find((ac) => ac.signal === hungSignal)!.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      await done;
      const byId = Object.fromEntries(db.deliveries.map((d) => [d.webhook_id, d.status]));
      expect(byId).toEqual({ hung: null, ok: 200 });
      const line = JSON.parse(String(log.mock.calls.find((c) => String(c[0]).includes('"hung"'))![0]));
      expect(line).toMatchObject({ webhook_id: 'hung', reason: `timed out after ${WEBHOOK_TIMEOUT_MS} ms` });
    } finally {
      spy.mockRestore();
    }
  });

  it('releases the response body after reading the status', async () => {
    const res = new Response('a large body the platform never reads');
    const cancel = vi.spyOn(res.body!, 'cancel');
    mockFetch.mockResolvedValueOnce(res);
    await dispatchWebhook(fakeDb([hook]), 'app1', 'test', {});
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('failure logs never contain the payload or the secret; success logs nothing', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await dispatchWebhook(fakeDb([hook]), 'app1', 'test', { private_note: 'do-not-log' });
    const text = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('connect ECONNREFUSED');
    expect(text).not.toContain('do-not-log');
    expect(text).not.toContain('whsec_secret_value');
    log.mockClear();
    mockFetch.mockResolvedValueOnce(new Response('ok'));
    await dispatchWebhook(fakeDb([hook]), 'app1', 'test', {});
    expect(log).not.toHaveBeenCalled();
  });
});

// #395: due app.alert retries, bounded attempts, removed hooks, and a DB failure.
describe('retryDueDeliveries (#395)', () => {
  function retryDb(rows: Record<string, unknown>[]) {
    const updates: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => ({ results: sql.includes('FROM webhook_deliveries d') ? rows : [] }),
          run: async () => { if (sql.startsWith('UPDATE')) updates.push([sql.includes("'webhook removed'") ? 'removed' : 'attempt', ...args]); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;
    return { db, updates };
  }
  const due = (over: Record<string, unknown> = {}) => ({ id: 'd1', event: 'app.alert', payload: '{}', attempts: 1, url: 'https://h.example/x', secret: 's', active: 1, ...over });

  it('resends a due delivery, records success, and schedules the next try on failure until the cap', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const ok = retryDb([due()]);
    expect(await retryDueDeliveries(ok.db, 1_000_000)).toBe(1);
    expect(ok.updates[0]).toEqual(['attempt', 'd1', 200, 2, 1000, null, null]);

    mockFetch.mockResolvedValueOnce(new Response('x', { status: 503 }));
    const failing = retryDb([due({ attempts: 2 })]);
    await retryDueDeliveries(failing.db, 1_000_000);
    expect(failing.updates[0]).toEqual(['attempt', 'd1', 503, 3, 1000, 1000 + 1800, 'HTTP 503']);

    mockFetch.mockResolvedValueOnce(new Response('x', { status: 503 }));
    const last = retryDb([due({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })]);
    await retryDueDeliveries(last.db, 1_000_000);
    expect(last.updates[0]![5]).toBeNull(); // the cap: no further attempt
  });

  it('a removed or deactivated webhook stops its retries without a request; a DB error returns 0', async () => {
    mockFetch.mockClear();
    const gone = retryDb([due({ url: null, secret: null, active: null }), due({ id: 'd2', active: 0 })]);
    await retryDueDeliveries(gone.db, 1_000_000);
    expect(gone.updates.map((u) => u[0])).toEqual(['removed', 'removed']);
    expect(mockFetch).not.toHaveBeenCalled();
    const broken = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await retryDueDeliveries(broken, 1)).toBe(0);
    err.mockRestore();
  });
});
