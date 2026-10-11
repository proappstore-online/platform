import { afterEach, describe, expect, it, vi } from 'vitest';
import { declaresPrivate, harvestTestResults, registerMcpTools, runDeployViaWorkflow, type DeployDeps, type WorkflowDeployArgs } from './deploy-stage.ts';

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
      hooks: [{ name: 'github', verify: { kind: 'github-hmac-sha256', secret: 'S' }, to: 'worker' }],
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

describe('harvestTestResults (#303 M5, #371)', () => {
  const SUMMARY = { passed: 3, failed: 1, ok: false, specs: [{ title: 'loads', ok: true }] };
  const TOKEN = 'tok-secret-value';
  const WHERE = 'slug: myapp, sha: abc1234, ticket: t1';

  function harvestDeps(kb: (() => Promise<Response>) | null, env: Record<string, unknown> = { INTERNAL_TOKEN: TOKEN }) {
    const activities: { type: string; detail: string }[] = [];
    const inserts: string[] = [];
    const fetchKb = vi.fn(async (_url: string, _init?: RequestInit) => kb!());
    const deps = {
      sql: { exec: (sql: string) => { if (sql.startsWith('INSERT')) inserts.push(sql); return { toArray: () => [] }; } },
      env: { ...env, ...(kb ? { KB: { fetch: fetchKb } } : {}) },
      logActivity: (type: string, detail: string) => { activities.push({ type, detail }); return 'log'; },
    } as unknown as DeployDeps;
    return { deps, activities, inserts, fetchKb };
  }
  const run = (deps: DeployDeps, isPrivate: boolean) => harvestTestResults(deps, { slug: 'myapp' }, 't1', 'abc1234', isPrivate);
  /** No log line, activity or warning may carry the token or a response body. */
  const clean = (h: ReturnType<typeof harvestDeps>, warn: ReturnType<typeof vi.spyOn>) => {
    const text = JSON.stringify([h.activities, warn.mock.calls]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('kb-body');
  };

  it('a public app\'s 404 is an explicit, non-fatal no_summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harvestDeps(async () => new Response('kb-body', { status: 404 }));
    await expect(run(h.deps, false)).resolves.toBe('no_summary');
    expect(h.activities).toEqual([{ type: 'test', detail: `No e2e summary yet (${WHERE})` }]);
    expect(warn).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it('a private app\'s authorised summary is harvested, sending the token only as the header', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harvestDeps(async () => Response.json(SUMMARY));
    await expect(run(h.deps, true)).resolves.toBe('harvested');
    expect(h.fetchKb.mock.calls[0]![1]).toEqual({ headers: { 'x-internal-token': TOKEN } });
    expect(h.activities).toEqual([{ type: 'test', detail: 'Test results harvested: 3 passed, 1 failed' }]);
    expect(h.inserts.map((q) => q.split('(')[0]!.trim())).toEqual(['INSERT OR REPLACE INTO test_runs', 'INSERT INTO test_results']);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('a private app\'s HTTP %i is an auth_failure naming the app, build and ticket — never the token', async (status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harvestDeps(async () => new Response('kb-body', { status }));
    await expect(run(h.deps, true)).resolves.toBe('auth_failure');
    const detail = `Private-app harvest authorization failure: HTTP ${status} from KB host (${WHERE}) — check INTERNAL_TOKEN on proappstore-kb-host`;
    expect(h.activities).toEqual([{ type: 'test', detail }]);
    expect(warn).toHaveBeenCalledWith(`[harvest] ${detail}`);
    expect(h.inserts).toEqual([]);
    clean(h, warn);
  });

  it.each([[503, false], [500, true], [429, false]])('HTTP %i is a failed harvest, logged with its status (private: %s)', async (status, isPrivate) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harvestDeps(async () => new Response('kb-body', { status }));
    await expect(run(h.deps, isPrivate)).resolves.toBe('failed');
    expect(h.activities).toEqual([{ type: 'test', detail: `Test harvest failed: HTTP ${status} from KB host (${WHERE})` }]);
    expect(h.inserts).toEqual([]);
    clean(h, warn);
  });

  it('a public app\'s 401/403 is not mistaken for "no summary"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const status of [401, 403]) {
      const h = harvestDeps(async () => new Response('', { status }));
      await expect(run(h.deps, false)).resolves.toBe('auth_failure');
    }
  });

  it('a thrown error is a failed harvest, logged with its correlation, and never throws out of a green deploy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harvestDeps(async () => { throw new Error('binding down'); });
    await expect(run(h.deps, false)).resolves.toBe('failed');
    expect(h.activities).toEqual([{ type: 'test', detail: `Test harvest error (${WHERE}): Error: binding down` }]);
    expect(warn).toHaveBeenCalledWith('[harvest] harvestTestResults error:', expect.any(Error));
  });

  it('without INTERNAL_TOKEN here: a public app is still harvested with no token header; a private one is skipped and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pub = harvestDeps(async () => new Response('Not found', { status: 404 }), {});
    await expect(run(pub.deps, false)).resolves.toBe('no_summary');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('INTERNAL_TOKEN is not set on agent-teams'));
    expect(pub.fetchKb.mock.calls[0]![1]).toEqual({ headers: {} });

    const priv = harvestDeps(async () => Response.json(SUMMARY), {});
    await expect(run(priv.deps, true)).resolves.toBe('skipped');
    expect(priv.fetchKb).not.toHaveBeenCalled();
    expect(priv.activities).toEqual([{ type: 'test', detail: `Private-app harvest skipped: INTERNAL_TOKEN is not set on proappstore-agent-teams (${WHERE})` }]);
  });

  it('without a KB binding (dev) skips, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harvestDeps(null);
    await expect(run(h.deps, true)).resolves.toBe('skipped');
    expect(h.activities).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

