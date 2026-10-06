import { afterEach, describe, expect, it, vi } from 'vitest';
import { declaresPrivate, registerMcpTools, runDeployViaWorkflow, type WorkflowDeployArgs } from './deploy-stage.ts';

/**
 * Tests the canary deploy path's outcome mapping: start the provisioning
 * Workflow once, then map its terminal status onto the ticket (complete→done,
 * CI-gate error→Dev, other error→needs-input, still-running→re-check/timeout).
 * The admin fetchers + the infraFail/fail routing closures are injected as spies.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function resp(ok: boolean, body: unknown, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function harness(opts: {
  ticket?: Partial<WorkflowDeployArgs['ticket']>;
  agentDeploy?: Response;
  status?: Response;
  siblings?: { id: string }[];
}) {
  const exec: { sql: string; args: unknown[] }[] = [];
  const events: unknown[] = [];
  const activities: { type: string; detail: string; ticketId: string | null | undefined }[] = [];
  const infraFail = vi.fn();
  const fail = vi.fn();
  const adminFetch = vi.fn(async (_path: string, _body: unknown) => opts.agentDeploy ?? resp(true, { id: 'wf-abc' }, 202));
  const adminGet = vi.fn(async (_path: string) => opts.status ?? resp(true, { status: { status: 'running' } }));

  const deps = {
    sql: {
      exec: (sql: string, ...args: unknown[]) => {
        exec.push({ sql, args });
        return {
          toArray: () => sql.includes('SELECT id FROM tickets WHERE id != ?') ? (opts.siblings ?? []) : [],
        };
      },
    },
    env: {}, // no PAS_BACKEND → post-deploy steps no-op
    broadcast: (e: unknown) => events.push(e),
    logActivity: (type: string, detail: string, ticketId?: string | null) => {
      activities.push({ type, detail, ticketId });
      return 'log';
    },
    storeMessage: async () => 'msg',
    loadFiles: () => new Map<string, string>(),
  } as unknown as WorkflowDeployArgs['deps'];

  const args: WorkflowDeployArgs = {
    deps,
    ticket: { iterations: 0, deploy_pushed_at: null, deploy_pushed_sha: null, ...opts.ticket },
    proj: { slug: 'myapp', name: 'My App', owner_id: 'u1', data_provisioned_at: 1 },
    files: new Map([['index.html', '<html></html>']]),
    ticketId: 't1',
    adminFetch,
    adminGet,
    infraFail,
    fail,
  };
  return { args, exec, events, activities, infraFail, fail, adminFetch, adminGet };
}

describe('runDeployViaWorkflow', () => {
  it('starts the workflow once and parks the instance id (first tick)', async () => {
    const instanceId = 'wf-0123456789abcdef';
    const h = harness({ agentDeploy: resp(true, { id: instanceId }, 202) });
    await runDeployViaWorkflow(h.args);

    expect(h.adminFetch).toHaveBeenCalledOnce();
    expect(h.adminFetch.mock.calls[0]![0]).toBe('/api/provision-workflow/agent');
    // instance id parked in deploy_pushed_sha; not polled yet
    const upd = h.exec.find((e) => e.sql.includes('deploy_pushed_sha'));
    expect(upd?.args).toContain(instanceId);
    // The marker is cleared on failure/retry; the append-only activity row is
    // the durable audit link back to the precise Cloudflare Workflow trace.
    expect(h.activities).toContainEqual(expect.objectContaining({
      type: 'deploy', ticketId: 't1', detail: expect.stringContaining(instanceId),
    }));
    expect(h.adminGet).not.toHaveBeenCalled();
    expect(h.infraFail).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('infra-fails when the workflow cannot be created', async () => {
    const h = harness({ agentDeploy: resp(false, { error: 'boom' }, 503) });
    await runDeployViaWorkflow(h.args);
    expect(h.infraFail).toHaveBeenCalledOnce();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('completes → marks the ticket done (green tail)', async () => {
    globalThis.fetch = vi.fn(async () => resp(false, {}, 404)); // harvest summary no-op
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' },
      status: resp(true, { status: { status: 'complete', output: { commitSha: 'deadbeef', repoUrl: 'https://gh/x' } } }),
    });
    await runDeployViaWorkflow(h.args);

    expect(h.adminGet).toHaveBeenCalledOnce();
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'transition', to: 'done' }));
    const done = h.exec.find((e) => e.sql.includes("status = 'done'"));
    expect(done?.args).toContain('deadbeef');
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.infraFail).not.toHaveBeenCalled();
  });

  it('authenticates private KB result harvests over the service binding (#277)', async () => {
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' },
      status: resp(true, { status: { status: 'complete', output: { commitSha: 'deadbeef' } } }),
    });
    const kbFetch = vi.fn(async () => resp(true, { passed: 3, failed: 0, ok: true }));
    h.args.deps.env.KB = { fetch: kbFetch } as unknown as Fetcher;
    h.args.deps.env.INTERNAL_TOKEN = 'platform-read-token';
    await runDeployViaWorkflow(h.args);
    expect(kbFetch).toHaveBeenCalledWith('https://kb.proappstore.online/myapp/.e2e/summary.json', {
      headers: { 'x-internal-token': 'platform-read-token' },
    });
    expect(h.exec.some((e) => e.sql.includes('INSERT OR REPLACE INTO test_runs'))).toBe(true);
  });

  it('green deploy marks sibling deploying tickets done from the shared tree', async () => {
    globalThis.fetch = vi.fn(async () => resp(false, {}, 404)); // harvest summary no-op
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' },
      status: resp(true, { status: { status: 'complete', output: { commitSha: 'deadbeef', repoUrl: 'https://gh/x' } } }),
      siblings: [{ id: 't2' }, { id: 't3' }],
    });
    await runDeployViaWorkflow(h.args);

    const siblingUpdates = h.exec.filter((e) =>
      e.sql.includes('UPDATE tickets SET status =') &&
      e.sql.includes('deploy_pushed_at = NULL') &&
      (e.args.includes('t2') || e.args.includes('t3')),
    );
    expect(siblingUpdates).toHaveLength(2);
    expect(siblingUpdates[0]?.args).toContain('deadbeef');
    expect(h.events).toContainEqual(expect.objectContaining({ ticketId: 't2', to: 'done', reason: 'shipped-by-sibling' }));
    expect(h.events).toContainEqual(expect.objectContaining({ ticketId: 't3', to: 'done', reason: 'shipped-by-sibling' }));
    expect(h.adminFetch).not.toHaveBeenCalled();
  });

  it('errored with a CI-gate failure → back to Dev (fail), with the message', async () => {
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' },
      status: resp(true, { status: { status: 'errored', error: 'CI gate: build failure\nTS2322' } }),
    });
    await runDeployViaWorkflow(h.args);
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.fail.mock.calls[0]![0]).toMatch(/CI gate: build failure[\s\S]*TS2322/);
    expect(h.infraFail).not.toHaveBeenCalled();
  });

  it('errored with a non-CI (infra) failure → needs-input (infraFail)', async () => {
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' },
      status: resp(true, { status: { status: 'errored', error: { message: 'github-repo: 422' } } }),
    });
    await runDeployViaWorkflow(h.args);
    expect(h.infraFail).toHaveBeenCalledOnce();
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('still running within the budget → re-checks (no terminal routing)', async () => {
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' },
      status: resp(true, { status: { status: 'running' } }),
    });
    await runDeployViaWorkflow(h.args);
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.infraFail).not.toHaveBeenCalled();
  });

  it('still running past the timeout → infra-fails', async () => {
    const h = harness({
      ticket: { deploy_pushed_at: 1, deploy_pushed_sha: 'wf-abc' }, // started long ago
      status: resp(true, { status: { status: 'running' } }),
    });
    await runDeployViaWorkflow(h.args);
    expect(h.infraFail).toHaveBeenCalledOnce();
  });
});

describe('private apps: visibility registration on a green deploy (#259 review)', () => {
  const PRIVATE_MCP = JSON.stringify({ tools: [], visibility: { mode: 'private', roles: ['viewer'] } });
  const complete = () => resp(true, { status: { status: 'complete', output: { commitSha: 'deadbeef', repoUrl: 'https://gh/x' } } });

  /** A PAS_BACKEND binding answering tools/internal with `status`, recording bodies. */
  function backend(status: number) {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (req: Request) => {
      bodies.push(await req.json());
      return new Response(JSON.stringify(status === 200 ? { registered: 0 } : { error: 'backend said no' }), { status });
    });
    return { binding: { fetch }, bodies, fetch };
  }
  const deps = (env: Record<string, unknown>) => {
    const activities: string[] = [];
    return { deps: { env, logActivity: (_t: string, d: string) => { activities.push(d); return 'log'; } } as unknown as Parameters<typeof registerMcpTools>[0], activities };
  };

  it('declaresPrivate reads mcp.json; anything unparseable or undeclared is not private', () => {
    expect(declaresPrivate(new Map([['mcp.json', PRIVATE_MCP]]))).toBe(true);
    expect(declaresPrivate(new Map([['mcp.json', '{"tools":[]}']]))).toBe(false);
    expect(declaresPrivate(new Map([['mcp.json', '{not json']]))).toBe(false);
    expect(declaresPrivate(new Map())).toBe(false);
  });

  it('registers a tool-less manifest that declares visibility (it used to be skipped, leaving the app public)', async () => {
    const b = backend(200);
    const { deps: d } = deps({ PAS_BACKEND: b.binding, INTERNAL_TOKEN: 'it' });
    expect(await registerMcpTools(d, { slug: 'diary' }, 't1', new Map([['mcp.json', PRIVATE_MCP]]))).toEqual({ ok: true, private: true });
    expect(b.bodies).toEqual([expect.objectContaining({ tools: [], visibility: { mode: 'private', roles: ['viewer'] } })]);
  });

  it('forwards every site-manifest key, worker included, so no deploy wipes one (#254)', async () => {
    const manifest = {
      tools: [{ name: 'upsert_repo' }], page_meta: [{ path: '/r/:id' }], sitemap: { action: 'list' }, operator: { prefix: '/admin' },
      operator_view: { version: 1 }, visibility: { mode: 'public' }, worker: { secrets: ['GITHUB_TOKEN'] },
    };
    const b = backend(200);
    const { deps: d } = deps({ PAS_BACKEND: b.binding, INTERNAL_TOKEN: 'it' });
    await registerMcpTools(d, { slug: 'repos' }, 't1', new Map([['mcp.json', JSON.stringify(manifest)]]));
    await registerMcpTools(d, { slug: 'repos' }, 't2', new Map([['mcp.json', JSON.stringify(manifest)]]));
    expect(b.bodies).toEqual([manifest, manifest]);
  });

  it('still skips a tool-less manifest that declares nothing', async () => {
    const b = backend(200);
    const { deps: d } = deps({ PAS_BACKEND: b.binding, INTERNAL_TOKEN: 'it' });
    expect(await registerMcpTools(d, { slug: 'diary' }, 't1', new Map([['mcp.json', '{"tools":[]}']]))).toEqual({ ok: true, private: false });
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('reports a failed private registration as a failure the caller must act on', async () => {
    const b = backend(400);
    const { deps: d } = deps({ PAS_BACKEND: b.binding, INTERNAL_TOKEN: 'it' });
    expect(await registerMcpTools(d, { slug: 'diary' }, 't1', new Map([['mcp.json', PRIVATE_MCP]]))).toEqual({ ok: false, private: true, reason: 'backend said no' });
  });

  it('a green deploy whose private manifest did not register is parked for a human, not done', async () => {
    globalThis.fetch = vi.fn(async () => resp(false, {}, 404)); // harvest summary no-op
    const h = harness({ ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' }, status: complete() });
    const b = backend(500);
    (h.args.deps as unknown as { env: Record<string, unknown> }).env = { PAS_BACKEND: b.binding, INTERNAL_TOKEN: 'it' };
    h.args.files = new Map([['index.html', '<html></html>'], ['mcp.json', PRIVATE_MCP]]);
    await runDeployViaWorkflow(h.args);

    const parked = h.exec.find((e) => e.sql.startsWith("UPDATE tickets SET status = 'needs-input'"));
    expect(parked?.args[0]).toMatch(/visibility: private.*NOT private/);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'transition', to: 'needs-input', reason: 'visibility-unregistered' }));
  });

  it('a green deploy whose private manifest registered stays done', async () => {
    globalThis.fetch = vi.fn(async () => resp(false, {}, 404));
    const h = harness({ ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'wf-abc' }, status: complete() });
    (h.args.deps as unknown as { env: Record<string, unknown> }).env = { PAS_BACKEND: backend(200).binding, INTERNAL_TOKEN: 'it' };
    h.args.files = new Map([['mcp.json', PRIVATE_MCP]]);
    await runDeployViaWorkflow(h.args);
    expect(h.exec.find((e) => e.sql.startsWith("UPDATE tickets SET status = 'needs-input'"))).toBeUndefined();
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'transition', to: 'done' }));
  });
});
