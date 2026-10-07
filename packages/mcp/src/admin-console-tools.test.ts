import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The admin-console authoring tools (#295). A fake McpServer captures each tool's
 * schema, annotations and handler; env.API.fetch is mocked to assert the exact
 * backend call, the bearer token, the read-only annotation and the audit row.
 */

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, { schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: Handler; description: string }>();
const fakeServer = {
  tool: (name: string, description: string, schema: z.ZodRawShape, annotations: Record<string, unknown>, handler: Handler) => {
    tools.set(name, { schema, annotations, handler, description });
  },
};

const apiFetch = vi.fn();
const kvPut = vi.fn();
const env = {
  API_BASE: 'https://api.test.com',
  API: { fetch: apiFetch } as unknown as Fetcher,
  OAUTH_KV: { put: kvPut } as unknown as KVNamespace,
} as Record<string, unknown>;

const { registerAdminConsoleTools } = await import('./admin-console-tools.js');

let userCtx: { userId: string | null; token: string | null } = { userId: 'gh:1', token: 'tok-1' };
registerAdminConsoleTools(fakeServer as never, env as never, () => userCtx);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const ok = (b: unknown) => apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(b), { status: 200 }));

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'gh:1', token: 'tok-1' };
  env.MCP_READ_ONLY = undefined;
});

describe('admin-console MCP tools (#295)', () => {
  it('registers all three as read-only, with descriptions and input schemas', () => {
    expect([...tools.keys()].sort()).toEqual(['inspect_admin_console', 'list_admin_capabilities', 'preview_admin_console']);
    for (const [name, t] of tools) {
      expect(t.annotations.readOnlyHint, name).toBe(true);
      expect(t.annotations.destructiveHint, name).toBe(false);
      expect(t.description.length, name).toBeGreaterThan(40);
    }
    expect(Object.keys(tools.get('inspect_admin_console')!.schema)).toEqual(['appId']);
    expect(Object.keys(tools.get('list_admin_capabilities')!.schema)).toEqual([]);
    expect(Object.keys(tools.get('preview_admin_console')!.schema)).toEqual(['appId', 'proposal', 'tools']);
    // appId is a slug: it is interpolated into the backend path.
    expect(z.object(tools.get('inspect_admin_console')!.schema).safeParse({ appId: '../admin' }).success).toBe(false);
  });

  it('inspect_admin_console GETs the inspect route with the bearer token, and audits the call', async () => {
    ok({ app_id: 'stash', gaps: [] });
    const res = await call('inspect_admin_console', { appId: 'stash' });
    expect(apiFetch).toHaveBeenCalledWith('https://api.test.com/v1/apps/stash/operator-view/inspect', expect.objectContaining({ method: 'GET' }));
    expect((apiFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok-1');
    expect(body(res)).toEqual({ app_id: 'stash', gaps: [] });
    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kvPut.mock.calls[0]![1] as string)).toMatchObject({ tool: 'inspect_admin_console', action: 'invoked' });
  });

  it('list_admin_capabilities GETs the capabilities route', async () => {
    ok({ limits: { resources: 20, actions: 20 } });
    const res = await call('list_admin_capabilities');
    expect(apiFetch).toHaveBeenCalledWith('https://api.test.com/v1/operator-view/capabilities', expect.objectContaining({ method: 'GET' }));
    expect(body(res)).toEqual({ limits: { resources: 20, actions: 20 } });
  });

  it('preview_admin_console POSTs { operator_view, tools? } and does not log the proposal', async () => {
    ok({ valid: true });
    const proposal = { version: 1, resources: [], actions: [] };
    await call('preview_admin_console', { appId: 'stash', proposal, tools: [{ name: 'op_x' }] });
    const [url, init] = apiFetch.mock.calls[0]! as [string, { method: string; body: string }];
    expect(url).toBe('https://api.test.com/v1/apps/stash/operator-view/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ operator_view: proposal, tools: [{ name: 'op_x' }] });
    expect(JSON.parse(kvPut.mock.calls[0]![1] as string)).toMatchObject({ tool: 'preview_admin_console', input: { appId: 'stash', tools: 1 } });
  });

  it('refuses without a session, and surfaces the backend refusal of a non-owner as an error', async () => {
    userCtx = { userId: null, token: null };
    const anon = await call('inspect_admin_console', { appId: 'stash' });
    expect(anon.isError).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();

    userCtx = { userId: 'gh:2', token: 'tok-2' };
    apiFetch.mockResolvedValueOnce(new Response('not the app owner', { status: 403 }));
    const refused = await call('preview_admin_console', { appId: 'stash', proposal: {} });
    expect(refused.isError).toBe(true);
    expect(body(refused).error).toBe('API 403: not the app owner');
  });

  it('still runs in read-only mode (nothing is changed)', async () => {
    env.MCP_READ_ONLY = '1';
    ok({ limits: {} });
    expect((await call('list_admin_capabilities')).isError).toBeUndefined();
  });
});
