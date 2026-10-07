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

// #296: apply_admin_update writes through build-core's GitHub client — faked here so every write is visible.
const gh = { getFile: vi.fn(), putFile: vi.fn(), deployResult: vi.fn() };
vi.mock('@proappstore/build-core', async (original) => ({ ...(await original<Record<string, unknown>>()), makeGitHub: () => gh }));

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
  gh.getFile.mockReset(); gh.putFile.mockReset(); gh.deployResult.mockReset();
});

describe('admin-console MCP tools (#295)', () => {
  it('registers all six with descriptions and input schemas; only apply_admin_update writes', () => {
    expect([...tools.keys()].sort()).toEqual([
      'apply_admin_update', 'inspect_admin_console', 'list_admin_capabilities', 'preview_admin_console', 'propose_admin_update', 'validate_admin_security',
    ]);
    for (const [name, t] of tools) {
      expect(t.annotations.readOnlyHint, name).toBe(name !== 'apply_admin_update');
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

  // ── #296 ──────────────────────────────────────────────────────────────────

  it('propose_admin_update POSTs the proposal with validate_against_actions and optional tools', async () => {
    ok({ valid: true, errors: [] });
    await call('propose_admin_update', { appId: 'stash', proposal: { version: 1 }, validateAgainstActions: false, tools: [{ name: 'op_x' }] });
    const [url, init] = apiFetch.mock.calls[0]! as [string, { method: string; body: string }];
    expect(url).toBe('https://api.test.com/v1/apps/stash/operator-view/propose');
    expect(JSON.parse(init.body)).toEqual({ operator_view: { version: 1 }, validate_against_actions: false, tools: [{ name: 'op_x' }] });
  });

  it('validate_admin_security returns passesSecurityGates with the issues', async () => {
    ok({ passes_security_gates: false, issues: [{ code: 'secret_exposure' }] });
    const res = body(await call('validate_admin_security', { appId: 'stash', proposal: { version: 1 } }));
    expect(apiFetch.mock.calls[0]![0]).toBe('https://api.test.com/v1/apps/stash/operator-view/security');
    expect(res).toMatchObject({ passesSecurityGates: false, issues: [{ code: 'secret_exposure' }] });
  });

  describe('apply_admin_update', () => {
    const proposal = { version: 1, resources: [], actions: [] };
    const repoManifest = { tools: [{ name: 'op_list' }], page_meta: [], operator_view: { version: 1, resources: [{ id: 'old' }], actions: [] }, visibility: { mode: 'public' } };
    const report = { valid: true, passes_security_gates: true, contract: { version: 1, resources: [], actions: [], audit: null }, warnings: [], security_issues: [] };
    const repo = () => gh.getFile.mockResolvedValue({ ok: true, status: 200, sha: 'file-sha', content: `${JSON.stringify(repoManifest, null, 2)}\n` });

    it('refuses without confirm, before reading the repo or calling the backend', async () => {
      const res = await call('apply_admin_update', { appId: 'stash', proposal });
      expect(res.isError).toBe(true);
      expect(body(res).error).toContain('confirm: true');
      expect(gh.getFile).not.toHaveBeenCalled();
      expect(apiFetch).not.toHaveBeenCalled();
      expect(gh.putFile).not.toHaveBeenCalled();
    });

    it("refuses a non-owner: the backend's 403, and nothing is written", async () => {
      repo();
      apiFetch.mockResolvedValueOnce(new Response('not the app owner', { status: 403 }));
      const res = await call('apply_admin_update', { appId: 'stash', proposal, confirm: true });
      expect(res.isError).toBe(true);
      expect(body(res).error).toBe('API 403: not the app owner');
      expect(gh.putFile).not.toHaveBeenCalled();
    });

    it("validates against the repo's own mcp.json tools, and never applies an invalid proposal or a failed security gate", async () => {
      repo();
      ok({ ...report, valid: false, errors: [{ path: 'operator_view.resources[0].action', message: 'x' }] });
      const invalid = await call('apply_admin_update', { appId: 'stash', proposal, confirm: true });
      expect(JSON.parse((apiFetch.mock.calls[0]![1] as { body: string }).body)).toEqual({ operator_view: proposal, tools: repoManifest.tools });
      expect(invalid.isError).toBe(true);
      expect(body(invalid).error).toContain('not applied');
      ok({ ...report, passes_security_gates: false });
      expect((await call('apply_admin_update', { appId: 'stash', proposal, confirm: true })).isError).toBe(true);
      expect(gh.putFile).not.toHaveBeenCalled();
    });

    it('dry_run shows the change without committing (no confirm needed)', async () => {
      repo();
      ok(report);
      const res = body(await call('apply_admin_update', { appId: 'stash', proposal, dry_run: true }));
      expect(res.dry_run).toBe(true);
      expect(String(res.plan)).toContain('commit mcp.json');
      expect(gh.putFile).not.toHaveBeenCalled();
    });

    it('commits ONE change to mcp.json only — operator_view replaced in place, the rest untouched — and reports the registration', async () => {
      repo();
      ok(report);
      gh.putFile.mockResolvedValue({ ok: true, status: 200, data: { commit: { sha: 'c0ffee' } } });
      gh.deployResult.mockResolvedValue({ ok: true, status: 'completed', conclusion: 'success', url: 'https://gh/run/1' });
      ok({ contract: report.contract });
      const res = body(await call('apply_admin_update', { appId: 'stash', proposal, confirm: true, wait_seconds: 30 }));

      expect(gh.putFile).toHaveBeenCalledTimes(1);
      const [app, path, content, message, sha] = gh.putFile.mock.calls[0]!;
      expect([app, path, sha]).toEqual(['stash', 'mcp.json', 'file-sha']);
      expect(message).toContain('operator_view');
      const written = JSON.parse(content as string);
      expect(Object.keys(written)).toEqual(['tools', 'page_meta', 'operator_view', 'visibility']);
      expect(written).toEqual({ ...repoManifest, operator_view: proposal });
      expect(gh.deployResult).toHaveBeenCalledWith('stash', { sha: 'c0ffee', waitMs: 30_000 });
      expect(apiFetch.mock.calls[1]![0]).toBe('https://api.test.com/v1/apps/stash/operator-view/inspect');
      expect(res).toMatchObject({ applied: true, commit: { sha: 'c0ffee', path: 'mcp.json' }, registration: { status: 'registered' } });
      expect(JSON.parse(kvPut.mock.calls.at(-1)![1] as string)).toMatchObject({ tool: 'apply_admin_update', action: 'invoked' });
    });

    it('reports a pending or failed deploy instead of claiming the registration', async () => {
      repo();
      ok(report);
      gh.putFile.mockResolvedValue({ ok: true, status: 200, data: { commit: { sha: 'c0ffee' } } });
      gh.deployResult.mockResolvedValueOnce({ ok: false, status: 'pending', errorTail: 'no deploy workflow run registered yet' });
      expect(body(await call('apply_admin_update', { appId: 'stash', proposal, confirm: true, wait_seconds: 0 })).registration).toMatchObject({ status: 'pending' });
      repo();
      ok(report);
      gh.deployResult.mockResolvedValueOnce({ ok: false, status: 'completed', conclusion: 'failure', errorTail: '::error::tools registration failed' });
      expect(body(await call('apply_admin_update', { appId: 'stash', proposal, confirm: true, wait_seconds: 0 })).registration).toMatchObject({ status: 'failed' });
    });

    it('is blocked in read-only mode, writing nothing', async () => {
      env.MCP_READ_ONLY = '1';
      repo();
      ok(report);
      await expect(call('apply_admin_update', { appId: 'stash', proposal, confirm: true })).rejects.toThrow(/read-only/);
      expect(gh.putFile).not.toHaveBeenCalled();
    });

    it('does not commit when mcp.json already holds the proposal', async () => {
      gh.getFile.mockResolvedValue({ ok: true, status: 200, sha: 's', content: `${JSON.stringify({ ...repoManifest, operator_view: proposal }, null, 2)}\n` });
      ok(report);
      expect(body(await call('apply_admin_update', { appId: 'stash', proposal, confirm: true }))).toMatchObject({ applied: false });
      expect(gh.putFile).not.toHaveBeenCalled();
    });
  });
});

