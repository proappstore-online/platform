import { describe, expect, it, vi, beforeEach } from 'vitest';

// The data-worker bundle is embedded at build time (scripts/embed-data-worker.mjs)
// and gitignored, so it doesn't exist during tests — mock it to a non-empty
// script. The empty-bundle fail-closed path is covered by its own test below.
vi.mock('../generated/data-worker-bundle.js', () => ({ DATA_WORKER_BUNDLE: '// embedded worker' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { deployDataWorker } = await import('./deploy-worker.js');

beforeEach(() => mockFetch.mockReset());

function mockSequence(...responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
  for (const r of responses) {
    mockFetch.mockResolvedValueOnce({
      ok: r.ok, status: r.status ?? (r.ok ? 200 : 500),
      json: () => Promise.resolve(r.body ?? {}),
      text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    } as Response);
  }
}

describe('deployDataWorker', () => {
  it('returns failure before upload when SESSION_SIGNING_KEY is missing', async () => {
    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', '');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('SESSION_SIGNING_KEY is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed (no upload) when the embedded bundle is empty', async () => {
    vi.resetModules();
    vi.doMock('../generated/data-worker-bundle.js', () => ({ DATA_WORKER_BUNDLE: '' }));
    const { deployDataWorker: fn } = await import('./deploy-worker.js');

    const result = await fn('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Embedded data-worker bundle is empty');
    expect(mockFetch).not.toHaveBeenCalled();

    vi.doUnmock('../generated/data-worker-bundle.js');
    vi.resetModules();
  });

  it('returns failure when worker upload fails', async () => {
    mockSequence(
      { ok: true, body: { success: false, errors: [{ message: 'quota exceeded' }] } },  // upload
    );

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('quota exceeded');
  });

  it('fails when custom domain attachment fails', async () => {
    mockSequence(
      { ok: true, body: { success: true } },    // upload
      { ok: true, body: {} },                    // subdomain enable
      { ok: true, body: { success: true, result: [{ id: 'zone-1' }] } },  // zone lookup
      { ok: true, body: { success: false, errors: [{ message: 'no permission' }] } },  // domain attach fails
    );

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(false);
    expect(result.url).toBe(result.workersDevUrl);
    expect(result.customDomain).toBeUndefined();
    expect(result.detail).toContain('custom domain required');
    expect(result.detail).toContain('no permission');
  });

  it('fails when custom domain zone lookup fails', async () => {
    mockSequence(
      { ok: true, body: { success: true } },    // upload
      { ok: true, body: {} },                    // subdomain enable
      { ok: true, body: { success: false, errors: [{ message: 'missing zone scope' }] } },
    );

    const result = await deployDataWorker('my-app', 'db-123', 'cf-tok', 'acct-1', 'sk');
    expect(result.ok).toBe(false);
    expect(result.customDomain).toBeUndefined();
    expect(result.detail).toContain('zone lookup failed');
    expect(result.detail).toContain('missing zone scope');
  });

  it('succeeds with custom domain when everything works', async () => {
    mockSequence(
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

  it('uploads the embedded bundle to the correct worker name', async () => {
    mockSequence(
      { ok: true, body: { success: true } },
      { ok: true, body: {} },
      { ok: true, body: { success: true, result: [{ id: 'z1' }] } },
      { ok: true, body: { success: true } },
    );

    await deployDataWorker('test-app', 'db-456', 'tok', 'acct', 'sk', 'internal-secret');

    // Upload is the first fetch now (no bundle fetch precedes it).
    const [uploadUrl, uploadInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(uploadUrl).toContain('workers/scripts/pas-data-test-app');
    const form = uploadInit.body as FormData;
    expect(await (form.get('worker.js') as Blob).text()).toBe('// embedded worker');
  });

  it('binds INTERNAL_TOKEN when provided, and omits it when empty', async () => {
    const bindingsFromUpload = async (internalToken: string) => {
      mockSequence(
        { ok: true, body: { success: true } },
        { ok: true, body: {} },
        { ok: true, body: { success: true, result: [{ id: 'z1' }] } },
        { ok: true, body: { success: true } },
      );
      await deployDataWorker('test-app', 'db-456', 'tok', 'acct', 'sk', internalToken);
      const form = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as FormData;
      const meta = JSON.parse(await (form.get('metadata') as Blob).text()) as {
        bindings: { name: string; type: string }[];
      };
      return meta.bindings.map((b) => b.name);
    };

    expect(await bindingsFromUpload('internal-secret')).toContain('INTERNAL_TOKEN');
    mockFetch.mockClear();
    expect(await bindingsFromUpload('')).not.toContain('INTERNAL_TOKEN');
  });
});
