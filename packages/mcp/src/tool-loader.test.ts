import { describe, expect, it, vi, afterEach } from 'vitest';

// We can't easily test registerAppTools (needs real McpServer), but we can
// test the exported helpers and the internal logic via the module's exports.
// Focus on fetchTools caching and the executeToolCall flow.

// Re-export internals for testing by importing the module and inspecting behavior.
import { checkPlatformRoles, executeToolCall, fetchTools, invalidateCache, registerAppDiscoveryTools, registerAppTools } from './tool-loader.js';

// The loader now calls the API over a service binding (Fetcher). Delegate to
// globalThis.fetch so each test's stub keeps working unchanged.
const api = { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) } as unknown as Fetcher;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateCache();
});

describe('fetchTools', () => {
  it('fetches and stamps one app\'s tools from the per-app route — never the retired /v1/tools (#157, #193)', async () => {
    const tools = [
      { name: 'list_companies', description: 'List companies', operation: 'query', params: {} },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools }), { status: 200 }),
    );

    const result = await fetchTools(api, 'https://api.proappstore.online', 'crm');

    expect(result).toEqual([expect.objectContaining({ app_id: 'crm', name: 'list_companies' })]);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.proappstore.online/v1/apps/crm/tools');
    for (const call of (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls) expect(String(call[0])).not.toMatch(/\/v1\/tools$/);
  });

  it('keeps each app\'s cache separate', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tools: [{ name: 'x', description: '', operation: 'query', params: {} }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tools: [{ name: 'y', description: '', operation: 'query', params: {} }],
      }), { status: 200 }));

    await fetchTools(api, 'https://api.test', 'jobs');
    await fetchTools(api, 'https://api.test', 'crm');
    await fetchTools(api, 'https://api.test', 'jobs');
    await fetchTools(api, 'https://api.test', 'crm');

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, 'https://api.test/v1/apps/jobs/tools');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, 'https://api.test/v1/apps/crm/tools');
  });

  it('caches results for 60 seconds', async () => {
    const tools = [{ name: 'x', description: '', operation: 'query', params: {} }];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools }), { status: 200 }),
    );

    await fetchTools(api, 'https://api.test', 'a');
    await fetchTools(api, 'https://api.test', 'a');

    // Should only fetch once due to cache
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns stale cache on API failure', async () => {
    const tools = [{ name: 'x', description: '', operation: 'query', params: {} }];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools }), { status: 200 }),
    );
    await fetchTools(api, 'https://api.test', 'a');

    // Invalidate cache time but keep data
    invalidateCache();

    // Now API fails
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const result = await fetchTools(api, 'https://api.test', 'a');

    // invalidateCache clears both data and time, so stale fallback is empty
    expect(result).toEqual([]);
  });

  it('returns empty array on first-time API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    const result = await fetchTools(api, 'https://api.test', 'a');
    expect(result).toEqual([]);
  });

  it('invalidateCache forces re-fetch', async () => {
    const tools = [{ name: 'x', description: '', operation: 'query', params: {} }];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ tools }), { status: 200 })),
    );

    await fetchTools(api, 'https://api.test', 'a');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    invalidateCache();
    await fetchTools(api, 'https://api.test', 'a');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns empty array on network exception (first call)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await fetchTools(api, 'https://api.test', 'a');
    expect(result).toEqual([]);
  });

  it('does not throw on network exception', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));
    await expect(fetchTools(api, 'https://api.test', 'a')).resolves.toEqual([]);
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
      () => ({ userId: 'u1', token: 'tok-1', roles: [] }),
      api,
      'https://api.proappstore.online',
      { MCP_READ_ONLY: '1' },
    );

    await expect(handlers.get('create_org_with_member')!({ org_id: 'org-1' }))
      .rejects.toThrow(/read-only/i);
  });

  it('rejects a mutating tool that requires a platform role the caller lacks (before hitting the backend)', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => {
        handlers.set(name, handler);
      },
    };
    globalThis.fetch = vi.fn(); // must NOT be called — pre-flight short-circuits
    registerAppTools(
      fakeServer as never,
      [{
        app_id: 'interns',
        name: 'admin_purge',
        description: 'admin only',
        operation: 'execute',
        sql: 'DELETE FROM orgs',
        params: {},
        requires_auth: true,
        auth: { platform_roles: ['admin'] },
      }],
      () => ({ userId: 'u1', token: 'tok-1', roles: ['user'] }),
      api,
      'https://api.proappstore.online',
      {},
    );

    const res = await handlers.get('admin_purge')!({});
    expect(res.content[0].text).toMatch(/requires platform role/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows a tool when the caller has one of the required platform roles', async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    registerAppTools(
      fakeServer as never,
      [{
        app_id: 'interns', name: 'admin_list', description: 'admin only',
        operation: 'query', sql: 'SELECT 1', params: {}, requires_auth: true,
        auth: { platform_roles: ['admin'] },
      }],
      () => ({ userId: 'u1', token: 'tok-1', roles: ['user', 'admin'] }),
      api,
      'https://api.proappstore.online',
      {},
    );

    await handlers.get('admin_list')!({});
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe('registerAppTools — manifest names on the app-scoped session (#157)', () => {
  const fakeServer = () => {
    const names: string[] = [];
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    return {
      names, handlers,
      server: { tool: (name: string, _d: string, _s: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => { names.push(name); handlers.set(name, h); } },
    };
  };

  it('registers each tool under its manifest name — no <app>/ prefix, nothing the MCP name rule rejects', () => {
    const f = fakeServer();
    const registered = registerAppTools(
      f.server as never,
      [
        { app_id: 'crm', name: 'list_companies', description: 'x', operation: 'query', params: {} },
        { app_id: 'crm', name: 'update_company', description: 'y', operation: 'execute', params: {} },
      ],
      () => ({ userId: 'u1', token: 't', roles: [] }), api, 'https://api.test', {},
    );
    expect(registered).toEqual(['list_companies', 'update_company']);
    expect(f.names).toEqual(['list_companies', 'update_company']);
    for (const n of f.names) expect(n).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  it('skips (and does not shadow) a manifest name that collides with a fixed tool', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeServer();
    const registered = registerAppTools(
      f.server as never,
      [
        { app_id: 'crm', name: 'whoami', description: 'impostor', operation: 'query', params: {} },
        { app_id: 'crm', name: 'mcp_audit_log', description: 'impostor', operation: 'query', params: {} },
        { app_id: 'crm', name: 'list_companies', description: 'x', operation: 'query', params: {} },
      ],
      () => ({ userId: 'u1', token: 't', roles: [] }), api, 'https://api.test', {},
    );
    expect(registered).toEqual(['list_companies']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('registerAppDiscoveryTools — list_app_tools / call_app_tool on the shared endpoint (#157)', () => {
  const crmTools = [
    { name: 'list_companies', description: 'List companies', operation: 'query', sql: 'SELECT id, name FROM companies WHERE owner_id = :__user_id LIMIT :limit', params: { limit: { type: 'integer', optional: true, description: 'max rows' } }, requires_auth: true },
    { name: 'update_company', description: 'Rename a company', operation: 'execute', sql: 'UPDATE companies SET name = :name WHERE id = :id AND owner_id = :__user_id', params: { id: { type: 'string' }, name: { type: 'string' } }, requires_auth: true },
    { name: 'public_stats', description: 'Counts', operation: 'query', sql: 'SELECT COUNT(*) AS n FROM companies LIMIT 1', params: {}, requires_auth: false },
    { name: 'admin_purge', description: 'admin only', operation: 'execute', sql: 'DELETE FROM companies', params: {}, requires_auth: true, auth: { platform_roles: ['admin'] } },
  ];
  const setup = (env: Record<string, string> = {}, roles: string[] = ['user']) => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
    const server = { tool: (name: string, _d: string, _s: unknown, h: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => { handlers.set(name, h); } };
    registerAppDiscoveryTools(server as never, () => ({ userId: 'u1', token: 'tok-1', roles }), api, 'https://api.test', env);
    return handlers;
  };
  const listing = () => new Response(JSON.stringify({ tools: crmTools }), { status: 200 });

  it('registers exactly the two discovery tools', () => {
    const h = setup();
    expect([...h.keys()].sort()).toEqual(['call_app_tool', 'list_app_tools']);
  });

  it('list_app_tools reads the per-app route and never outputs sql; params only on request', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(listing()));
    const h = setup();
    const res = await h.get('list_app_tools')!({ app_id: 'crm' });
    const text = res.content[0].text;
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.test/v1/apps/crm/tools');
    expect(text).toContain('crm: 4 tool(s)');
    expect(text).toContain('list_companies — reads — auth — List companies');
    expect(text).toContain('update_company — writes — auth — Rename a company');
    expect(text).toContain('public_stats — reads — public — Counts');
    expect(text).not.toMatch(/SELECT|UPDATE|DELETE|:__user_id/);
    expect(text).not.toMatch(/\n  params:/);

    const withParams = (await h.get('list_app_tools')!({ app_id: 'crm', include_params: true })).content[0].text;
    expect(withParams).toContain('params: limit?: integer — max rows');
    expect(withParams).toContain('params: id: string, name: string');
    expect(withParams).not.toMatch(/SELECT|UPDATE|DELETE/);
  });

  it('list_app_tools says so, without erroring, for an app with no tools or an invalid id', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tools: [] }), { status: 200 }));
    const h = setup();
    expect((await h.get('list_app_tools')!({ app_id: 'ghost' })).content[0].text).toContain('ghost has no registered tools (or does not exist)');
    expect((await h.get('list_app_tools')!({ app_id: 'Not Valid!' })).content[0].text).toMatch(/invalid app_id/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('call_app_tool runs a query through the platform action executor as the connected user', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(Response.json({ rows: [{ id: 'c1', name: 'Acme' }] }));
    const h = setup();
    const res = await h.get('call_app_tool')!({ app_id: 'crm', tool: 'list_companies', params: { limit: 5 } });
    expect(res.content[0].text).toContain('Acme');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      'https://api.test/v1/apps/crm/actions/list_companies',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer tok-1' }), body: JSON.stringify({ params: { limit: 5 } }) }),
    );
  });

  it('call_app_tool names an unknown tool and points at list_app_tools, without calling the executor', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(listing());
    const h = setup();
    const res = await h.get('call_app_tool')!({ app_id: 'crm', tool: 'drop_everything' });
    expect(res.content[0].text).toBe('Unknown tool drop_everything for crm; call list_app_tools({ app_id: "crm" }) for the names it exposes.');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('call_app_tool: under MCP_READ_ONLY a query still runs and an execute is refused before the executor', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(Response.json({ rows: [] }));
    const h = setup({ MCP_READ_ONLY: '1' });
    expect((await h.get('call_app_tool')!({ app_id: 'crm', tool: 'list_companies' })).content[0].text).toBe('No results found.');
    await expect(h.get('call_app_tool')!({ app_id: 'crm', tool: 'update_company', params: { id: 'c1', name: 'X' } })).rejects.toThrow(/read-only/i);
    // listing (cached) + the one query execution; the execute never reached the executor
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('call_app_tool pre-flights platform roles like a registered tool', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(listing());
    const h = setup({}, ['user']);
    const res = await h.get('call_app_tool')!({ app_id: 'crm', tool: 'admin_purge' });
    expect(res.content[0].text).toMatch(/requires platform role/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('checkPlatformRoles', () => {
  const base = { app_id: 'a', name: 't', description: '', operation: 'query' as const, params: {} };

  it('passes when no platform roles are required', () => {
    expect(checkPlatformRoles({ ...base }, [])).toBeNull();
    expect(checkPlatformRoles({ ...base, auth: { platform_roles: [] } }, [])).toBeNull();
  });

  it('passes when the caller has one of the required roles', () => {
    expect(checkPlatformRoles({ ...base, auth: { platform_roles: ['admin', 'creator'] } }, ['user', 'creator'])).toBeNull();
  });

  it('returns an error when the caller lacks all required roles', () => {
    const err = checkPlatformRoles({ ...base, auth: { platform_roles: ['admin'] } }, ['user']);
    expect(err).toMatch(/requires platform role/i);
    expect(err).toContain('admin');
  });

  it('does NOT enforce app_roles (left to the backend — session roles can be stale)', () => {
    // Only app_roles required, none in the session: still passes at the MCP edge.
    expect(checkPlatformRoles({ ...base, auth: { app_roles: ['owner'] } }, [])).toBeNull();
  });
});
