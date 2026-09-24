import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env.js';

/**
 * The surface guard (#157 step 4): the shared /mcp endpoint registers a fixed
 * number of tools however many app tools exist, never fetches the retired
 * cross-app listing, and never registers a name the MCP spec rejects; an
 * app-scoped session registers exactly that app's manifest names plus the
 * fixed identity/audit tools. Driven through the real `PasMcpAgent.init()`
 * with `McpServer` replaced by a recorder and the API binding stubbed.
 */
const registered = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    env!: Env;
    props: Record<string, unknown> = {};
    static serve() { return { fetch: async () => new Response('mock') }; }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string) { registered.names.push(name); }
  },
}));

vi.mock('./api-helpers.js', () => ({
  extractToken: (props: { authToken?: string }) => props.authToken ?? null,
  verifyToken: async () => ({ id: 'gh:1', login: 'tester' }),
  fetchAccount: async () => null,
}));

const { PasMcpAgent } = await import('./index.js');
const { MCP_APP_SCOPED_FIXED, MCP_SHARED_TOOL_COUNT } = await import('./tool-count.js');
const { invalidateCache } = await import('./tool-loader.js');

function syntheticTools(n: number, descriptionBytes = 0) {
  return Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `synthetic ${i}${'x'.repeat(descriptionBytes)}`, operation: 'query', params: {} }));
}

async function boot(opts: { appScope?: string; appTools: number; descriptionBytes?: number }) {
  registered.names.length = 0;
  invalidateCache();
  const fetched: string[] = [];
  const api = {
    fetch: async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ tools: syntheticTools(opts.appTools, opts.descriptionBytes) }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  } as unknown as Fetcher;
  const agent = new PasMcpAgent({} as never, {} as never) as unknown as { env: Env; props: Record<string, unknown>; init(): Promise<void> };
  agent.env = { API: api, API_BASE: 'https://api.test', SESSION_SIGNING_KEY: 'k' } as unknown as Env;
  agent.props = { authToken: 'session', ...(opts.appScope ? { appScope: opts.appScope } : {}) };
  await agent.init();
  return { names: [...registered.names], fetched };
}

afterEach(() => { registered.names.length = 0; });

describe('the shared /mcp surface (#157)', () => {
  it('registers MCP_SHARED_TOOL_COUNT tools with 0 app tools, and the same number with 500', async () => {
    const empty = await boot({ appTools: 0 });
    const many = await boot({ appTools: 500 });
    expect(empty.names).toHaveLength(MCP_SHARED_TOOL_COUNT);
    expect(many.names).toHaveLength(MCP_SHARED_TOOL_COUNT);
    expect(new Set(many.names).size).toBe(many.names.length);
  });

  it('never fetches app tools for the shared session, and never the retired /v1/tools', async () => {
    const { fetched } = await boot({ appTools: 500 });
    expect(fetched).toEqual([]);
  });

  it('registers no name the MCP tool-name rule rejects, and carries the discovery pair instead of discover_tools', async () => {
    const { names } = await boot({ appTools: 5 });
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(names).toContain('list_app_tools');
    expect(names).toContain('call_app_tool');
    expect(names).not.toContain('discover_tools');
    expect(names).toContain('whoami');
    expect(names).toContain('mcp_audit_log');
  });
});

describe('an app-scoped /mcp/apps/<id> surface (#157)', () => {
  it('registers the app\'s manifest names plus the fixed tools, fetched from the per-app route only', async () => {
    const { names, fetched } = await boot({ appScope: 'crm', appTools: 3 });
    expect(names).toHaveLength(3 + MCP_APP_SCOPED_FIXED);
    expect(names).toEqual(expect.arrayContaining(['tool_0', 'tool_1', 'tool_2', 'whoami', 'mcp_audit_log']));
    for (const n of names) expect(n).not.toContain('/');
    expect(fetched).toEqual(['https://api.test/v1/apps/crm/tools']);
    expect(names).not.toContain('list_app_tools');
  });
});

describe('an app-scoped session with a LARGE manifest (#117 progressive disclosure)', () => {
  it('registers the core (here none: no core flag, no get_/count_) plus the scoped discovery pair and the fixed tools — not the manifest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { names } = await boot({ appScope: 'chess', appTools: 120, descriptionBytes: 400 }); // ~55 KB of tools/list
    expect(names).toHaveLength(2 + MCP_APP_SCOPED_FIXED);
    expect(names).toEqual(expect.arrayContaining(['list_app_tools', 'call_app_tool', 'whoami', 'mcp_audit_log']));
    expect(names).not.toContain('tool_0');
    vi.restoreAllMocks();
  });

  it('leaves a small manifest exactly as before', async () => {
    const { names } = await boot({ appScope: 'chess', appTools: 40 }); // ~4 KB
    expect(names).toHaveLength(40 + MCP_APP_SCOPED_FIXED);
    expect(names).not.toContain('list_app_tools');
  });
});
