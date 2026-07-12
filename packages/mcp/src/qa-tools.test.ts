import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the QA MCP tools. A fake McpServer captures the registered
 * handlers; env.API.fetch is mocked so we assert the exact backend call
 * (method + path + body) each tool makes, plus auth + read-only gating.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const tools = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
    tools.set(name, handler);
  },
};

const apiFetch = vi.fn();
const env = {
  API_BASE: 'https://api.test.com',
  API: { fetch: apiFetch } as unknown as Fetcher,
  // safety.isReadOnly reads MCP_READ_ONLY off env; default off.
} as Record<string, unknown>;

const { registerQaTools } = await import('./qa-tools.js');

let userCtx: { userId: string | null; token: string | null } = { userId: 'u1', token: 'tok-1' };
registerQaTools(fakeServer as never, env as never, () => userCtx);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!(args);
const textOf = (r: { content: { type: string; text: string }[] }) => r.content[0]!.text;
const okJson = (body: unknown) => apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'u1', token: 'tok-1' };
  delete env.MCP_READ_ONLY;
});
afterEach(() => vi.clearAllMocks());

describe('QA MCP tools', () => {
  it('registers the full framework surface', () => {
    expect([...tools.keys()].sort()).toEqual(
      ['qa_delete_flow', 'qa_flow_playwright', 'qa_list_flows', 'qa_list_runs', 'qa_mint_key', 'qa_run', 'qa_run_artifacts', 'qa_save_flow'].sort(),
    );
  });

  it('qa_list_flows GETs the flows with the bearer token', async () => {
    okJson({ flows: [{ flow_id: 'sign-in' }] });
    const res = await call('qa_list_flows', { appId: 'chess-academy' });
    expect(apiFetch).toHaveBeenCalledWith('https://api.test.com/v1/apps/chess-academy/qa/flows', expect.objectContaining({ method: 'GET' }));
    const init = apiFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(textOf(res)).toContain('sign-in');
  });

  it('qa_save_flow PUTs the flow to its id path with a {flow} body', async () => {
    okJson({ ok: true, flowId: 'sign-in' });
    const flow = { id: 'sign-in', name: 'Sign-in renders', steps: [{ op: 'expectText', text: 'Sign in' }] };
    await call('qa_save_flow', { appId: 'chess-academy', flow });
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('https://api.test.com/v1/apps/chess-academy/qa/flows/sign-in');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ flow });
  });

  it('qa_run POSTs one flow, or all when flowId is omitted', async () => {
    okJson({ ok: true, runs: [{ runId: 'r1', flowId: 'sign-in' }] });
    await call('qa_run', { appId: 'chess-academy', flowId: 'sign-in' });
    expect(JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ flowId: 'sign-in', trigger: 'manual' });

    okJson({ ok: true, runs: [] });
    await call('qa_run', { appId: 'chess-academy' });
    expect(JSON.parse((apiFetch.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ trigger: 'manual' });
  });

  it('qa_list_runs adds the flowId query only when given', async () => {
    okJson({ runs: [] });
    await call('qa_list_runs', { appId: 'chess-academy' });
    expect(apiFetch.mock.calls[0]![0]).toBe('https://api.test.com/v1/apps/chess-academy/qa/runs');
    okJson({ runs: [] });
    await call('qa_list_runs', { appId: 'chess-academy', flowId: 'sign-in' });
    expect(apiFetch.mock.calls[1]![0]).toBe('https://api.test.com/v1/apps/chess-academy/qa/runs?flowId=sign-in');
  });

  it('qa_run_artifacts GETs the run artifacts list', async () => {
    okJson({ artifacts: [{ name: 'final.png', size: 100 }] });
    const res = await call('qa_run_artifacts', { appId: 'chess-academy', runId: 'r1' });
    expect(apiFetch.mock.calls[0]![0]).toBe('https://api.test.com/v1/apps/chess-academy/qa/runs/r1/artifacts');
    expect(textOf(res)).toContain('final.png');
  });

  it('qa_flow_playwright returns the transpiled text body verbatim', async () => {
    apiFetch.mockResolvedValueOnce(new Response("import { test } from '@playwright/test'", { status: 200 }));
    const res = await call('qa_flow_playwright', { appId: 'chess-academy', flowId: 'sign-in' });
    expect(textOf(res)).toContain('@playwright/test');
  });

  it('qa_mint_key POSTs to the keys endpoint', async () => {
    okJson({ ok: true, key: 'qak_abc', keyId: 'abc' });
    const res = await call('qa_mint_key', { appId: 'chess-academy' });
    expect(apiFetch.mock.calls[0]![0]).toBe('https://api.test.com/v1/apps/chess-academy/qa/keys');
    expect((apiFetch.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(textOf(res)).toContain('qak_abc');
  });

  it('surfaces backend errors instead of throwing', async () => {
    apiFetch.mockResolvedValueOnce(new Response('not owner', { status: 403 }));
    const res = await call('qa_list_flows', { appId: 'chess-academy' });
    expect(textOf(res)).toContain('403');
  });

  it('refuses when the connection is unauthenticated (no token)', async () => {
    userCtx = { userId: null, token: null };
    const res = await call('qa_list_flows', { appId: 'chess-academy' });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(textOf(res)).toContain('Not authenticated');
  });

  it('blocks mutations in read-only mode (and never calls the backend)', async () => {
    env.MCP_READ_ONLY = '1';
    await expect(call('qa_run', { appId: 'chess-academy' })).rejects.toThrow(/read-only/i);
    await expect(call('qa_save_flow', { appId: 'chess-academy', flow: { id: 'x', name: 'x', steps: [{ op: 'goto', path: '/' }] } })).rejects.toThrow(/read-only/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
