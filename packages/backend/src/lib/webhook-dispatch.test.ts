import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { dispatchWebhook, MAX_WEBHOOKS_PER_APP, WEBHOOK_TIMEOUT_MS } = await import('./webhook-dispatch.js');

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
