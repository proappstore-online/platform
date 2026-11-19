import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Tests for the app email MCP tools (#605). A fake McpServer captures the handlers;
 * env.API.fetch is mocked so we assert the exact backend call each tool makes. Who may
 * do what (owner, editor, administrator, stranger) is the backend's decision: the
 * tools forward the connection's session and return its refusal, code included.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
const tools = new Map<string, Handler>();
const schemas = new Map<string, z.ZodRawShape>();
const fakeServer = {
  tool: (name: string, _desc: string, schema: z.ZodRawShape, _annotations: unknown, handler: Handler) => {
    tools.set(name, handler);
    schemas.set(name, schema);
  },
};

const apiFetch = vi.fn();
const env = { API_BASE: 'https://api.test.com', API: { fetch: apiFetch } as unknown as Fetcher } as Record<string, unknown>;

const { registerAppEmailTools } = await import('./app-email-tools.js');

let userCtx: { userId: string | null; token: string | null } = { userId: 'u1', token: 'tok-1' };
registerAppEmailTools(fakeServer as never, env as never, () => userCtx);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args);
const textOf = (r: { content: { type: string; text: string }[] }) => r.content[0]!.text;
const okJson = (body: unknown, status = 200) => apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
const lastCall = () => {
  const [url, init] = apiFetch.mock.calls[0]! as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
};

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'u1', token: 'tok-1' };
  delete env.MCP_READ_ONLY;
});

describe('app email MCP tools', () => {
  it('registers the setup surface and no send tool', () => {
    expect([...tools.keys()].sort()).toEqual([
      'admin_email_attest_domain', 'app_email_approve_identity', 'app_email_claim_domain', 'app_email_declare_identity',
      'app_email_list_sends', 'app_email_list_suppressions', 'app_email_revoke_identity', 'app_email_status',
    ]);
    for (const shape of schemas.values()) for (const k of ['from', 'sender', 'to', 'subject', 'html', 'text']) expect(shape, k).not.toHaveProperty(k);
  });

  it('app_email_status GETs the owner route with the session token', async () => {
    okJson({ configured: true, domains: [], identities: [] });
    const res = await call('app_email_status', { app_id: 'hiring' });
    const { url, init } = lastCall();
    expect(url).toBe('https://api.test.com/v1/apps/hiring/email');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(textOf(res)).toContain('configured');
  });

  it('app_email_claim_domain POSTs the domain', async () => {
    okJson({ domain: 'betabuilders.org', status: 'pending' }, 201);
    await call('app_email_claim_domain', { app_id: 'hiring', domain: 'betabuilders.org' });
    const { url, init, body } = lastCall();
    expect(url).toBe('https://api.test.com/v1/apps/hiring/email/domains');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ domain: 'betabuilders.org' });
  });

  it('app_email_declare_identity maps snake_case params to the route body', async () => {
    okJson({ id: 'i1', status: 'pending' }, 201);
    await call('app_email_declare_identity', { app_id: 'hiring', address: 'careers@betabuilders.org', display_name: 'Careers', reply_to: 'hr@betabuilders.org' });
    const { url, body } = lastCall();
    expect(url).toBe('https://api.test.com/v1/apps/hiring/email/identities');
    expect(body).toEqual({ address: 'careers@betabuilders.org', displayName: 'Careers', replyTo: 'hr@betabuilders.org' });
  });

  it('app_email_declare_identity omits unset optionals', async () => {
    okJson({ id: 'i1' }, 201);
    await call('app_email_declare_identity', { app_id: 'hiring', address: 'careers@betabuilders.org' });
    expect(lastCall().body).toEqual({ address: 'careers@betabuilders.org' });
  });

  it('app_email_approve_identity and revoke hit the identity routes', async () => {
    okJson({ status: 'approved' });
    await call('app_email_approve_identity', { app_id: 'hiring', identity_id: 'i1', allow_external: true });
    expect(lastCall().url).toBe('https://api.test.com/v1/apps/hiring/email/identities/i1/approve');
    expect(lastCall().body).toEqual({ allowExternal: true });
    apiFetch.mockClear();
    okJson({ status: 'revoked' });
    await call('app_email_revoke_identity', { app_id: 'hiring', identity_id: 'i1' });
    expect(lastCall().url).toBe('https://api.test.com/v1/apps/hiring/email/identities/i1/revoke');
    expect(lastCall().init.method).toBe('POST');
  });

  it('list tools GET sends (with limit) and suppressions', async () => {
    okJson({ sends: [] });
    await call('app_email_list_sends', { app_id: 'hiring', limit: 20 });
    expect(lastCall().url).toBe('https://api.test.com/v1/apps/hiring/email/sends?limit=20');
    apiFetch.mockClear();
    okJson({ sends: [] });
    await call('app_email_list_sends', { app_id: 'hiring' });
    expect(lastCall().url).toBe('https://api.test.com/v1/apps/hiring/email/sends');
    apiFetch.mockClear();
    okJson({ suppressions: [] });
    await call('app_email_list_suppressions', { app_id: 'hiring' });
    expect(lastCall().url).toBe('https://api.test.com/v1/apps/hiring/email/suppressions');
  });

  it('admin_email_attest_domain sends verified, and forwardCopyTo only when given (null clears)', async () => {
    okJson({ domain: 'betabuilders.org', status: 'verified' });
    await call('admin_email_attest_domain', { domain: 'betabuilders.org', verified: true });
    expect(lastCall().url).toBe('https://api.test.com/v1/admin/email/domains/betabuilders.org');
    expect(lastCall().body).toEqual({ verified: true });
    apiFetch.mockClear();
    okJson({});
    await call('admin_email_attest_domain', { domain: 'betabuilders.org', verified: true, forward_copy_to: 'me@example.com' });
    expect(lastCall().body).toEqual({ verified: true, forwardCopyTo: 'me@example.com' });
    apiFetch.mockClear();
    okJson({});
    await call('admin_email_attest_domain', { domain: 'betabuilders.org', verified: true, forward_copy_to: null });
    expect(lastCall().body).toEqual({ verified: true, forwardCopyTo: null });
  });

  it.each([
    ['stranger', 404, { error: 'app not found' }],
    ['editor on an owner route', 403, { error: 'not the app owner' }],
    ['non-admin on the admin route', 403, { error: 'admin required' }],
    ['a refused claim', 409, { error: 'domain taken', code: 'domain_taken' }],
  ])('returns the backend refusal unchanged: %s', async (_who, status, body) => {
    okJson(body, status);
    const res = await call('app_email_claim_domain', { app_id: 'hiring', domain: 'betabuilders.org' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`API ${status}: ${JSON.stringify(body)}`.replace(/"/g, '\\"'));
  });

  it('refuses when there is no session, without calling the backend', async () => {
    userCtx = { userId: null, token: null };
    for (const [name, args] of [
      ['app_email_status', { app_id: 'hiring' }],
      ['app_email_claim_domain', { app_id: 'hiring', domain: 'a.org' }],
      ['admin_email_attest_domain', { domain: 'a.org', verified: true }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError, name).toBe(true);
      expect(textOf(res)).toContain('Not authenticated');
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('blocks every mutation in read-only mode but still reads', async () => {
    env.MCP_READ_ONLY = 'true';
    await expect(call('app_email_claim_domain', { app_id: 'hiring', domain: 'a.org' })).rejects.toThrow(/read-only/);
    await expect(call('app_email_declare_identity', { app_id: 'hiring', address: 'a@a.org' })).rejects.toThrow(/read-only/);
    await expect(call('app_email_approve_identity', { app_id: 'hiring', identity_id: 'i1', allow_external: false })).rejects.toThrow(/read-only/);
    await expect(call('app_email_revoke_identity', { app_id: 'hiring', identity_id: 'i1' })).rejects.toThrow(/read-only/);
    await expect(call('admin_email_attest_domain', { domain: 'a.org', verified: true })).rejects.toThrow(/read-only/);
    expect(apiFetch).not.toHaveBeenCalled();
    okJson({ configured: true });
    await call('app_email_status', { app_id: 'hiring' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects path-shaped ids at the schema', () => {
    expect(z.object(schemas.get('app_email_status')!).safeParse({ app_id: 'a/../b' }).success).toBe(false);
    expect(z.object(schemas.get('app_email_revoke_identity')!).safeParse({ app_id: 'hiring', identity_id: '../x' }).success).toBe(false);
    expect(z.object(schemas.get('admin_email_attest_domain')!).safeParse({ domain: 'a.org/../x', verified: true }).success).toBe(false);
  });
});
