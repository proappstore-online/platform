import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { dispatchWebhook } = await import('./webhook-dispatch.js');

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

beforeEach(() => mockFetch.mockReset());

describe('dispatchWebhook', () => {
  it('does nothing when no hooks are registered', async () => {
    const db = fakeDb([]);
    await dispatchWebhook(db, 'app1', 'notification.sent', { id: '1' });
    expect(mockFetch).not.toHaveBeenCalled();
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
