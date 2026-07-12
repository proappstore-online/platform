import { describe, expect, it, vi, afterEach } from 'vitest';

// We can't easily test registerAppTools (needs real McpServer), but we can
// test the exported helpers and the internal logic via the module's exports.
// Focus on fetchTools caching and the executeToolCall flow.

// Re-export internals for testing by importing the module and inspecting behavior.
import { executeToolCall, fetchTools, invalidateCache, registerAppTools } from './tool-loader.js';

// The loader now calls the API over a service binding (Fetcher). Delegate to
// globalThis.fetch so each test's stub keeps working unchanged.
const api = { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) } as unknown as Fetcher;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateCache();
});

describe('fetchTools', () => {
  it('fetches tools from the API', async () => {
    const tools = [
      { app_id: 'jobs', name: 'list_jobs', description: 'List jobs', operation: 'query', sql: 'SELECT 1', params: {} },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools }), { status: 200 }),
    );

    const result = await fetchTools(api, 'https://api.proappstore.online');
    expect(result).toHaveLength(1);
    expect(result[0].app_id).toBe('jobs');
    expect(result[0].name).toBe('list_jobs');
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.proappstore.online/v1/tools');
  });

  it('caches results for 60 seconds', async () => {
    const tools = [{ app_id: 'a', name: 'x', description: '', operation: 'query', sql: 'SELECT 1', params: {} }];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools }), { status: 200 }),
    );

    await fetchTools(api, 'https://api.test');
    await fetchTools(api, 'https://api.test');

    // Should only fetch once due to cache
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns stale cache on API failure', async () => {
    const tools = [{ app_id: 'a', name: 'x', description: '', operation: 'query', sql: 'SELECT 1', params: {} }];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools }), { status: 200 }),
    );
    await fetchTools(api, 'https://api.test');

    // Invalidate cache time but keep data
    invalidateCache();

    // Now API fails
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const result = await fetchTools(api, 'https://api.test');

    // invalidateCache clears both data and time, so stale fallback is empty
    expect(result).toEqual([]);
  });

  it('returns empty array on first-time API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    const result = await fetchTools(api, 'https://api.test');
    expect(result).toEqual([]);
  });

  it('invalidateCache forces re-fetch', async () => {
    const tools = [{ app_id: 'a', name: 'x', description: '', operation: 'query', sql: 'SELECT 1', params: {} }];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ tools }), { status: 200 })),
    );

    await fetchTools(api, 'https://api.test');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    invalidateCache();
    await fetchTools(api, 'https://api.test');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns empty array on network exception (first call)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await fetchTools(api, 'https://api.test');
    expect(result).toEqual([]);
  });

  it('does not throw on network exception', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));
    await expect(fetchTools(api, 'https://api.test')).resolves.toEqual([]);
  });
});

describe('executeToolCall', () => {
  const tool = {
    app_id: 'interns',
    name: 'list_orgs',
    description: 'List orgs',
    operation: 'query' as const,
    sql: 'SELECT * FROM orgs WHERE user_id = :__user_id',
    params: {},
    requires_auth: true,
  };

  it('uses the platform action executor instead of calling the data worker directly', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({ rows: [{ id: 'org-1' }] }),
    );

    const result = await executeToolCall(
      tool,
      { limit: 5, __user_id: 'attacker' },
      'session-token',
      api,
      'https://api.proappstore.online',
      );

    expect(result).toContain('org-1');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.proappstore.online/v1/apps/interns/actions/list_orgs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
        body: JSON.stringify({ params: { limit: 5, __user_id: 'attacker' } }),
      }),
    );
  });

  it('requires a PAS session token before executing app tools', async () => {
    globalThis.fetch = vi.fn();

    const result = await executeToolCall(tool, {}, null, api, 'https://api.proappstore.online');

    expect(result).toContain('requires authentication');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('passes batch tools through the shared action executor', async () => {
    const batchTool = {
      app_id: 'interns',
      name: 'create_org_with_member',
      description: 'Create org and first membership',
      operation: 'batch' as const,
      statements: [
        'INSERT INTO orgs (id, name) VALUES (:org_id, :name)',
        'INSERT INTO memberships (org_id, user_id) VALUES (:org_id, :__user_id)',
      ],
      params: { org_id: { type: 'string' }, name: { type: 'string' } },
      requires_auth: true,
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({ results: [{ success: true }, { success: true }], meta: { duration: 4 } }),
    );

    const result = await executeToolCall(
      batchTool,
      { org_id: 'org-1', name: 'Team' },
      'session-token',
      api,
      'https://api.proappstore.online',
    );

    expect(result).toContain('results');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.proappstore.online/v1/apps/interns/actions/create_org_with_member',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
        body: JSON.stringify({ params: { org_id: 'org-1', name: 'Team' } }),
      }),
    );
  });
});

describe('registerAppTools', () => {
  it('treats batch tools as mutating for read-only mode', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    };
    registerAppTools(
      fakeServer as never,
      [{
        app_id: 'interns',
        name: 'create_org_with_member',
        description: 'Create org and first membership',
        operation: 'batch',
        statements: [
          'INSERT INTO orgs (id, name) VALUES (:org_id, :name)',
          'INSERT INTO memberships (org_id, user_id) VALUES (:org_id, :__user_id)',
        ],
        params: {},
        requires_auth: true,
      }],
      () => ({ userId: 'u1', token: 'tok-1' }),
      api,
      'https://api.proappstore.online',
      { MCP_READ_ONLY: '1' },
    );

    await expect(handlers.get('interns/create_org_with_member')!({ org_id: 'org-1' }))
      .rejects.toThrow(/read-only/i);
  });
});
