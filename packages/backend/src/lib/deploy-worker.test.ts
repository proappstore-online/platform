import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { deployDataWorker } = await import('./deploy-worker.js');

beforeEach(() => mockFetch.mockReset());

function mockSequence(...responses: Array<{ ok: boolean; status?: number; body?: unknown; text?: string }>) {
  for (const r of responses) {
    if (r.text !== undefined) {
      mockFetch.mockResolvedValueOnce({
        ok: r.ok, status: r.status ?? (r.ok ? 200 : 500),
        text: () => Promise.resolve(r.text),
      } as Response);
    } else {
      mockFetch.mockResolvedValueOnce({
        ok: r.ok, status: r.status ?? (r.ok ? 200 : 500),
        json: () => Promise.resolve(r.body ?? {}),
        text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
      } as Response);
    }
  }
}

describe('deployDataWorker', () => {
  it('returns failure before upload when SESSION_SIGNING_KEY is missing', async () => {
    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', '');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('SESSION_SIGNING_KEY is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns failure when bundle fetch fails', async () => {
    mockSequence({ ok: false, status: 404, text: 'Not Found' });

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Failed to fetch worker bundle');
  });

  it('returns failure when worker upload fails', async () => {
    mockSequence(
      { ok: true, text: '// worker script' },  // bundle fetch
      { ok: true, body: { success: false, errors: [{ message: 'quota exceeded' }] } },  // upload
    );

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('quota exceeded');
  });

  it('succeeds with workers.dev URL when custom domain fails', async () => {
    mockSequence(
      { ok: true, text: '// worker script' },  // bundle fetch
      { ok: true, body: { success: true } },    // upload
      { ok: true, body: {} },                    // subdomain enable
      { ok: true, body: { success: true, result: [{ id: 'zone-1' }] } },  // zone lookup
      { ok: true, body: { success: false, errors: [{ message: 'no permission' }] } },  // domain attach fails
    );

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(true);
    expect(result.url).toContain('workers.dev');
    expect(result.customDomain).toBeUndefined();
    expect(result.detail).toContain('custom domain skipped');
  });

  it('succeeds with custom domain when everything works', async () => {
    mockSequence(
      { ok: true, text: '// worker script' },  // bundle fetch
      { ok: true, body: { success: true } },    // upload
      { ok: true, body: {} },                    // subdomain enable
      { ok: true, body: { success: true, result: [{ id: 'zone-1' }] } },  // zone lookup
      { ok: true, body: { success: true } },    // domain attach
    );

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://data-my-app.proappstore.online');
    expect(result.customDomain).toBe('data-my-app.proappstore.online');
    expect(result.workersDevUrl).toContain('pas-data-my-app');
  });

  it('uses correct worker name and bindings', async () => {
    mockSequence(
      { ok: true, text: '// script' },
      { ok: true, body: { success: true } },
      { ok: true, body: {} },
      { ok: true, body: { success: true, result: [{ id: 'z1' }] } },
      { ok: true, body: { success: true } },
    );

    await deployDataWorker('test-app', 'db-456', 'tok', 'acct', 'sk');

    // Check the upload call (2nd fetch)
    const [uploadUrl] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(uploadUrl).toContain('workers/scripts/pas-data-test-app');
  });
});
