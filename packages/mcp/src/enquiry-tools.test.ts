import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/** The owner-only enquiry tools (#413): exact backend calls, bearer token, refusals, read-only mode. */

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, { schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: Handler }>();
const fakeServer = {
  tool: (name: string, _d: string, schema: z.ZodRawShape, annotations: Record<string, unknown>, handler: Handler) => {
    tools.set(name, { schema, annotations, handler });
  },
};

const apiFetch = vi.fn();
const kvPut = vi.fn();
const env = {
  API_BASE: 'https://api.test.com',
  API: { fetch: apiFetch } as unknown as Fetcher,
  OAUTH_KV: { put: kvPut } as unknown as KVNamespace,
} as Record<string, unknown>;

const { registerEnquiryTools } = await import('./enquiry-tools.js');
let userCtx: { userId: string | null; token: string | null } = { userId: 'gh:1', token: 'tok-1' };
registerEnquiryTools(fakeServer as never, env as never, () => userCtx);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, any>;
const reply = (b: unknown, status = 200) =>
  apiFetch.mockResolvedValueOnce(new Response(typeof b === 'string' ? b : JSON.stringify(b), { status }));
function sent(n = 0) {
  const [url, init] = apiFetch.mock.calls[n] as [string, RequestInit];
  return {
    method: init.method,
    path: url.replace('https://api.test.com', ''),
    auth: (init.headers as Record<string, string>).Authorization,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'gh:1', token: 'tok-1' };
  env.MCP_READ_ONLY = undefined;
});

describe('enquiry MCP tools (#413)', () => {
  it('registers three tools; only mark_enquiry_handled writes', () => {
    expect([...tools.keys()].sort()).toEqual(['get_enquiry', 'list_enquiries', 'mark_enquiry_handled']);
    for (const [name, t] of tools) expect(t.annotations.readOnlyHint, name).toBe(name !== 'mark_enquiry_handled');
  });

  it('slug-checks ids interpolated into the backend path', () => {
    const s = z.object(tools.get('get_enquiry')!.schema);
    expect(s.safeParse({ app_id: 'stash', enquiry_id: 'abc-123' }).success).toBe(true);
    expect(s.safeParse({ app_id: '../admin', enquiry_id: 'abc' }).success).toBe(false);
    expect(s.safeParse({ app_id: 'stash', enquiry_id: '../x' }).success).toBe(false);
  });

  it('every tool refuses without a session and calls nothing', async () => {
    userCtx = { userId: null, token: null };
    for (const name of tools.keys()) {
      const r = await call(name, { app_id: 'stash', enquiry_id: 'e1' });
      expect(r.isError, name).toBe(true);
      expect(body(r).error).toMatch(/Not authenticated/);
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('list_enquiries passes filters and the cursor, with the connection token', async () => {
    reply({ enquiries: [], counts: { new: 0, total: 0 }, next: null });
    const r = await call('list_enquiries', { app_id: 'stash', status: 'new', limit: 20, before_id: 'e9' });
    expect(sent()).toEqual({ method: 'GET', path: '/v1/apps/stash/enquiries?status=new&limit=20&before_id=e9', auth: 'Bearer tok-1', body: undefined });
    expect(body(r).counts).toEqual({ new: 0, total: 0 });
    reply({ enquiries: [] });
    await call('list_enquiries', { app_id: 'stash' });
    expect(sent(1).path).toBe('/v1/apps/stash/enquiries');
  });

  it('a non-owner gets the backend refusal as an error (403 passes through)', async () => {
    reply('forbidden', 403);
    const r = await call('list_enquiries', { app_id: 'stash' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe('API 403: forbidden');
  });

  it('get_enquiry reads one; a missing one is an error', async () => {
    reply({ id: 'e1', name: 'Ann', status: 'new' });
    expect(body(await call('get_enquiry', { app_id: 'stash', enquiry_id: 'e1' })).name).toBe('Ann');
    expect(sent()).toMatchObject({ method: 'GET', path: '/v1/apps/stash/enquiries/e1' });
    reply('no such enquiry', 404);
    expect((await call('get_enquiry', { app_id: 'stash', enquiry_id: 'zz' })).isError).toBe(true);
  });

  it('mark_enquiry_handled patches status; handled:false reopens', async () => {
    reply({ id: 'e1', status: 'handled' });
    await call('mark_enquiry_handled', { app_id: 'stash', enquiry_id: 'e1' });
    expect(sent()).toMatchObject({ method: 'PATCH', path: '/v1/apps/stash/enquiries/e1', body: { status: 'handled' } });
    reply({ id: 'e1', status: 'new' });
    await call('mark_enquiry_handled', { app_id: 'stash', enquiry_id: 'e1', handled: false });
    expect(sent(1).body).toEqual({ status: 'new' });
  });

  it('mark_enquiry_handled is refused in read-only mode; reads still work', async () => {
    env.MCP_READ_ONLY = '1';
    await expect(call('mark_enquiry_handled', { app_id: 'stash', enquiry_id: 'e1' })).rejects.toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
    reply({ enquiries: [] });
    expect((await call('list_enquiries', { app_id: 'stash' })).isError).toBeUndefined();
  });
});
