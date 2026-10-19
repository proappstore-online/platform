import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The ownership tools (#423). A fake McpServer captures each tool; env.API.fetch
 * is mocked to assert the exact backend call, the connection's bearer token,
 * the confirm gates, read-only mode and the audit rows.
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

const { registerOwnershipTools } = await import('./ownership-tools.js');

let userCtx: { userId: string | null; token: string | null } = { userId: 'gh:1', token: 'tok-1' };
registerOwnershipTools(fakeServer as never, env as never, () => userCtx);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, any>;
const reply = (b: unknown, status = 200) =>
  apiFetch.mockResolvedValueOnce(new Response(typeof b === 'string' ? b : JSON.stringify(b), { status }));
/** The nth backend call: method, path, bearer and parsed body. */
function sent(n = 0) {
  const [url, init] = apiFetch.mock.calls[n] as [string, RequestInit];
  return {
    method: init.method,
    path: url.replace('https://api.test.com', ''),
    auth: (init.headers as Record<string, string>).Authorization,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}
const audits = () => kvPut.mock.calls.map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'gh:1', token: 'tok-1' };
  env.MCP_READ_ONLY = undefined;
});

describe('ownership MCP tools (#423)', () => {
  it('registers the five tools; only ownership_status is read-only', () => {
    expect([...tools.keys()].sort()).toEqual([
      'ownership_status', 'request_ownership_recovery', 'request_ownership_transfer', 'resolve_ownership_request', 'respond_ownership_transfer',
    ]);
    for (const [name, t] of tools) {
      expect(t.annotations.readOnlyHint, name).toBe(name === 'ownership_status');
      expect(t.description.length, name).toBeGreaterThan(80);
    }
    // app_id is a slug: it is interpolated into the backend path.
    const appId = z.object(tools.get('ownership_status')!.schema);
    expect(appId.safeParse({ app_id: 'stash' }).success).toBe(true);
    expect(appId.safeParse({ app_id: '../admin' }).success).toBe(false);
    expect(z.object(tools.get('resolve_ownership_request')!.schema).safeParse({ app_id: 'a', transfer_id: 1, action: 'approve' }).success).toBe(false);
  });

  it('every tool refuses without a session and calls nothing', async () => {
    userCtx = { userId: null, token: null };
    for (const name of tools.keys()) {
      const r = await call(name, { app_id: 'stash', to: 'x', transfer_id: 1, action: 'decline', evidence: 'e', reason: 'r', confirm: true });
      expect(r.isError, name).toBe(true);
      expect(body(r).error).toMatch(/Not authenticated/);
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  describe('ownership_status', () => {
    it('reads the backend view with the connection token, passed through unchanged', async () => {
      reply({ app_id: 'stash', you: 'none', owner: null, can_request_recovery: true });
      const r = await call('ownership_status', { app_id: 'stash' });
      expect(sent()).toEqual({ method: 'GET', path: '/v1/apps/stash/ownership', auth: 'Bearer tok-1', body: undefined });
      expect(body(r)).toEqual({ app_id: 'stash', you: 'none', owner: null, can_request_recovery: true });
      expect(audits()[0]).toMatchObject({ tool: 'ownership_status', action: 'invoked', subject: 'gh:1' });
    });

    it('still works in read-only mode, and surfaces backend errors as isError', async () => {
      env.MCP_READ_ONLY = '1';
      reply('app not found', 404);
      const r = await call('ownership_status', { app_id: 'nope' });
      expect(r.isError).toBe(true);
      expect(body(r).error).toBe('API 404: app not found');
    });
  });

  describe('request_ownership_transfer', () => {
    const implications = { dry_run: true, to: { login: 'riley' }, implications: { repository: { full_name: 'proappstore-online/stash' } } };

    it('without confirm: shows the backend dry run and refuses to create', async () => {
      reply(implications);
      const r = await call('request_ownership_transfer', { app_id: 'stash', to: 'riley' });
      expect(r.isError).toBe(true);
      expect(sent()).toMatchObject({ method: 'POST', path: '/v1/apps/stash/ownership/transfer', body: { to: 'riley', dry_run: true } });
      expect(apiFetch).toHaveBeenCalledTimes(1);
      const b = body(r);
      expect(b.error).toMatch(/confirm: true/);
      expect(b.preview).toContain('proappstore-online/stash');
      expect(b.preview).toContain('No changes were made');
    });

    it('dry_run: the same preview, not an error, audited as a dry run', async () => {
      reply(implications);
      const r = await call('request_ownership_transfer', { app_id: 'stash', to: 'riley', dry_run: true, confirm: true });
      expect(r.isError).toBeUndefined();
      expect(sent().body).toEqual({ to: 'riley', dry_run: true });
      expect(audits()[0]).toMatchObject({ tool: 'request_ownership_transfer', action: 'dry_run' });
    });

    it('a refused preview (unverified recipient, not the owner) is the backend message', async () => {
      reply('recipient is not a verified PAS identity', 400);
      const r = await call('request_ownership_transfer', { app_id: 'stash', to: 'ghost' });
      expect(body(r).error).toBe('API 400: recipient is not a verified PAS identity');
    });

    it('with confirm: creates the request', async () => {
      reply({ transfer: { id: 7, status: 'pending' } }, 201);
      const r = await call('request_ownership_transfer', { app_id: 'stash', to: 'riley', message: 'yours now', confirm: true });
      expect(sent()).toEqual({ method: 'POST', path: '/v1/apps/stash/ownership/transfer', auth: 'Bearer tok-1', body: { to: 'riley', message: 'yours now' } });
      expect(body(r)).toEqual({ transfer: { id: 7, status: 'pending' } });
      expect(audits()[0]).toMatchObject({ tool: 'request_ownership_transfer', action: 'invoked' });
    });

    it('read-only mode blocks the write but not the preview', async () => {
      env.MCP_READ_ONLY = '1';
      await expect(call('request_ownership_transfer', { app_id: 'stash', to: 'riley', confirm: true })).rejects.toThrow(/read-only/);
      expect(apiFetch).not.toHaveBeenCalled();
      reply(implications);
      expect((await call('request_ownership_transfer', { app_id: 'stash', to: 'riley', dry_run: true })).isError).toBeUndefined();
    });
  });

  describe('respond_ownership_transfer', () => {
    const open = { open: [{ id: 7, kind: 'transfer', status: 'pending', implications: { route: { url: 'https://stash.proappstore.online' } } }] };

    it('accept without confirm shows the transfer it would accept, and accepts nothing', async () => {
      reply(open);
      const r = await call('respond_ownership_transfer', { app_id: 'stash', transfer_id: 7, action: 'accept' });
      expect(r.isError).toBe(true);
      expect(sent()).toMatchObject({ method: 'GET', path: '/v1/apps/stash/ownership' });
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(body(r).preview).toContain('https://stash.proappstore.online');
    });

    it('accept preview of a transfer you cannot see is an error', async () => {
      reply(open);
      const r = await call('respond_ownership_transfer', { app_id: 'stash', transfer_id: 99, action: 'accept', dry_run: true });
      expect(body(r).error).toMatch(/No open transfer 99/);
    });

    it('accept with confirm posts to the accept route', async () => {
      reply({ transfer: { id: 7, status: 'accepted' } });
      await call('respond_ownership_transfer', { app_id: 'stash', transfer_id: 7, action: 'accept', confirm: true });
      expect(sent()).toMatchObject({ method: 'POST', path: '/v1/apps/stash/ownership/transfer/7/accept', body: {} });
    });

    it.each(['decline', 'cancel'])('%s needs no confirm', async (action) => {
      reply({ transfer: { id: 7 } });
      await call('respond_ownership_transfer', { app_id: 'stash', transfer_id: 7, action });
      expect(sent()).toMatchObject({ method: 'POST', path: `/v1/apps/stash/ownership/transfer/7/${action}`, body: {} });
    });

    it('escalate forwards the reason', async () => {
      reply({ transfer: { id: 7, status: 'escalated' } });
      await call('respond_ownership_transfer', { app_id: 'stash', transfer_id: 7, action: 'escalate', reason: 'lost the invited sign-in' });
      expect(sent()).toMatchObject({ path: '/v1/apps/stash/ownership/transfer/7/escalate', body: { reason: 'lost the invited sign-in' } });
    });

    it('a backend refusal (not the recipient, expired) is isError', async () => {
      reply('this transfer has expired', 410);
      const r = await call('respond_ownership_transfer', { app_id: 'stash', transfer_id: 7, action: 'decline' });
      expect(body(r).error).toBe('API 410: this transfer has expired');
    });
  });

  describe('request_ownership_recovery', () => {
    it('files the request with the evidence', async () => {
      reply({ transfer: { id: 8, kind: 'recovery', status: 'escalated' } }, 201);
      const r = await call('request_ownership_recovery', { app_id: 'stash', evidence: 'I created it as gh:3' });
      expect(sent()).toEqual({ method: 'POST', path: '/v1/apps/stash/ownership/recovery', auth: 'Bearer tok-1', body: { evidence: 'I created it as gh:3' } });
      expect(body(r).transfer.status).toBe('escalated');
      // The evidence is not copied into the MCP audit trail.
      expect(JSON.stringify(audits())).not.toContain('I created it');
    });

    it('is blocked in read-only mode', async () => {
      env.MCP_READ_ONLY = '1';
      await expect(call('request_ownership_recovery', { app_id: 'stash', evidence: 'x' })).rejects.toThrow(/read-only/);
    });
  });

  describe('resolve_ownership_request', () => {
    it('approve needs confirm', async () => {
      const r = await call('resolve_ownership_request', { app_id: 'stash', transfer_id: 8, action: 'approve', reason: 'verified' });
      expect(r.isError).toBe(true);
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it('approve with confirm posts to the admin route', async () => {
      reply({ transfer: { id: 8, status: 'admin_approved' } });
      await call('resolve_ownership_request', { app_id: 'stash', transfer_id: 8, action: 'approve', reason: 'verified by commit signature', confirm: true });
      expect(sent()).toEqual({
        method: 'POST', path: '/v1/admin/apps/stash/ownership/transfer/8/resolve', auth: 'Bearer tok-1',
        body: { action: 'approve', reason: 'verified by commit signature' },
      });
    });

    it('reject maps to the backend decline, without confirm', async () => {
      reply({ transfer: { id: 8, status: 'declined' } });
      await call('resolve_ownership_request', { app_id: 'stash', transfer_id: 8, action: 'reject', reason: 'no evidence' });
      expect(sent().body).toEqual({ action: 'decline', reason: 'no evidence' });
    });

    it('a non-admin gets the backend refusal', async () => {
      reply('admin only', 403);
      const r = await call('resolve_ownership_request', { app_id: 'stash', transfer_id: 8, action: 'reject', reason: 'x' });
      expect(body(r).error).toBe('API 403: admin only');
    });
  });
});
