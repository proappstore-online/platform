import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDeployViaWorkflow, type WorkflowDeployArgs } from './deploy-stage.ts';

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
}) {
  const exec: { sql: string; args: unknown[] }[] = [];
  const events: unknown[] = [];
  const infraFail = vi.fn();
  const fail = vi.fn();
  const adminFetch = vi.fn(async (_path: string, _body: unknown) => opts.agentDeploy ?? resp(true, { id: 'wf-abc' }, 202));
  const adminGet = vi.fn(async (_path: string) => opts.status ?? resp(true, { status: { status: 'running' } }));

  const deps = {
    sql: { exec: (sql: string, ...args: unknown[]) => { exec.push({ sql, args }); return { toArray: () => [] }; } },
    env: {}, // no PAS_BACKEND → post-deploy steps no-op
    broadcast: (e: unknown) => events.push(e),
    logActivity: () => 'log',
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
  return { args, exec, events, infraFail, fail, adminFetch, adminGet };
}

describe('runDeployViaWorkflow', () => {
  it('starts the workflow once and parks the instance id (first tick)', async () => {
    const h = harness({ agentDeploy: resp(true, { id: 'wf-abc' }, 202) });
    await runDeployViaWorkflow(h.args);

    expect(h.adminFetch).toHaveBeenCalledOnce();
    expect(h.adminFetch.mock.calls[0]![0]).toBe('/api/provision-workflow/agent');
    // instance id parked in deploy_pushed_sha; not polled yet
    const upd = h.exec.find((e) => e.sql.includes('deploy_pushed_sha'));
    expect(upd?.args).toContain('wf-abc');
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
