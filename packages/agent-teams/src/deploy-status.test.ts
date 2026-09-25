import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUrlFor, deployStatusOf, runDeployStage, setDeployStatus, type DeployDeps } from './deploy-stage.ts';

/**
 * #9 — the deploy status the console's preview panel renders. The inline deploy
 * path is driven with a stub ADMIN binding; every step must record its state on
 * the project row and announce it as `deploy-status`.
 */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function resp(ok: boolean, body: unknown, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function harness(opts: { admin?: (path: string, body: unknown) => Response; ticket?: Record<string, unknown>; noAdmin?: boolean }) {
  const updates: { sql: string; args: unknown[] }[] = [];
  const events: Record<string, unknown>[] = [];
  const ticket = { title: 'T', iterations: 0, deploy_pushed_at: null, deploy_pushed_sha: null, ...opts.ticket };
  const proj = { slug: 'myapp', name: 'My App', owner_id: 'u1', data_provisioned_at: 1 };
  const adminFetch = vi.fn(async (req: Request) => opts.admin!(new URL(req.url).pathname, await req.json()));
  const deps = {
    sql: {
      exec: (sql: string, ...args: unknown[]) => {
        if (/^\s*UPDATE/i.test(sql)) updates.push({ sql, args });
        return {
          toArray: () => {
            if (sql.includes('FROM tickets WHERE id = ?') && sql.includes('deploy_pushed_at')) return [ticket];
            if (sql.includes('deploy_attempts FROM tickets')) return [{ deploy_attempts: 0 }];
            if (sql.includes('FROM project')) return [proj];
            return [];
          },
        };
      },
    },
    env: opts.noAdmin ? { INTERNAL_TOKEN: 'internal' } : { ADMIN: { fetch: adminFetch }, INTERNAL_TOKEN: 'internal' },
    broadcast: (e: Record<string, unknown>) => events.push(e),
    logActivity: () => 'log',
    storeMessage: async () => 'msg',
    loadFiles: () => new Map([['index.html', '<html></html>']]),
  } as unknown as DeployDeps;
  const statuses = () => events.filter((e) => e.type === 'deploy-status').map((e) => ({ state: e.state, sha: e.sha, ciUrl: e.ciUrl, ticketId: e.ticketId, detail: e.detail, appUrl: e.appUrl }));
  const rowUpdates = () => updates.filter((u) => u.sql.startsWith('UPDATE project SET deploy_state')).map((u) => u.args[0]);
  return { deps, events, statuses, rowUpdates, adminFetch };
}

describe('deploy status (#9)', () => {
  it('inline path: deploying → building on push, then live on a green build — recorded on the project row and announced', async () => {
    globalThis.fetch = vi.fn(async () => resp(false, {}, 404)); // post-deploy harvest no-op
    const h = harness({
      admin: (path) => path === '/api/agent-deploy'
        ? resp(true, { success: true, commitSha: 'abc1234def', repoUrl: 'https://github.com/x/myapp' })
        : resp(true, { ok: true, status: 'completed', conclusion: 'success', url: 'https://github.com/x/myapp/actions/runs/1' }),
    });
    await runDeployStage(h.deps, 't1');
    expect(h.statuses()).toEqual([
      { state: 'deploying', sha: null, ciUrl: null, ticketId: 't1', detail: 'pushing 1 file(s)', appUrl: 'https://myapp.proappstore.online' },
      { state: 'building', sha: 'abc1234def', ciUrl: null, ticketId: 't1', detail: 'CI building abc1234', appUrl: 'https://myapp.proappstore.online' },
      { state: 'live', sha: 'abc1234def', ciUrl: 'https://github.com/x/myapp/actions/runs/1', ticketId: 't1', detail: 'deployed abc1234', appUrl: 'https://myapp.proappstore.online' },
    ]);
    expect(h.rowUpdates()).toEqual(['deploying', 'building', 'live']);
    // The ticket is done, announced before the live status.
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('transition')).toBeLessThan(types.lastIndexOf('deploy-status'));
  });

  it('a red build is a failed status carrying the reason (and the ticket goes back to Dev)', async () => {
    const h = harness({
      ticket: { deploy_pushed_at: Date.now(), deploy_pushed_sha: 'abc1234def' },
      admin: () => resp(true, { ok: false, status: 'completed', conclusion: 'failure', errorTail: 'TS2304: Cannot find name' }),
    });
    await runDeployStage(h.deps, 't1');
    expect(h.statuses()).toEqual([expect.objectContaining({ state: 'failed', sha: 'abc1234def', detail: expect.stringContaining('build failed: CI build failure') })]);
    expect(h.events.some((e) => e.type === 'transition' && e.to === 'dev-active')).toBe(true);
  });

  it('a push the platform refuses is a failed status (blocked: infra) after the deploying announcement', async () => {
    const h = harness({ admin: () => resp(false, { success: false, steps: [{ name: 'repo', status: 'fail', detail: 'org quota' }] }, 503) });
    await runDeployStage(h.deps, 't1');
    expect(h.statuses().map((s) => s.state)).toEqual(['deploying', 'failed']);
    expect(h.statuses()[1]!.detail).toContain('blocked (infra)');
    expect(h.events.some((e) => e.type === 'transition' && e.to === 'needs-input')).toBe(true);
  });

  it('with no deploy binding the ticket is marked done and the status says nothing was built', async () => {
    const h = harness({ noAdmin: true });
    await runDeployStage(h.deps, 't1');
    expect(h.statuses()).toEqual([expect.objectContaining({ state: 'live', sha: null, detail: 'Deploy binding unavailable → done (nothing was built)' })]);
  });

  it('deployStatusOf reads a row back (idle for a project that never deployed); setDeployStatus survives a pre-migration row', () => {
    expect(deployStatusOf({ slug: 'x' }, 'x')).toEqual({ state: 'idle', sha: null, at: null, ciUrl: null, ticketId: null, detail: null, appUrl: 'https://x.proappstore.online' });
    expect(deployStatusOf({ deploy_state: 'live', deploy_sha: 'abc', deploy_at: 5, deploy_ci_url: 'u', deploy_ticket_id: 't', deploy_detail: 'd' }, 'x'))
      .toEqual({ state: 'live', sha: 'abc', at: 5, ciUrl: 'u', ticketId: 't', detail: 'd', appUrl: 'https://x.proappstore.online' });
    expect(appUrlFor('my-app')).toBe('https://my-app.proappstore.online');
    const events: Record<string, unknown>[] = [];
    const deps = { sql: { exec: () => { throw new Error('no such column: deploy_state'); } }, broadcast: (e: Record<string, unknown>) => events.push(e) } as unknown as Pick<DeployDeps, 'sql' | 'broadcast'>;
    const s = setDeployStatus(deps, 'x', 'building', { ticketId: 't', sha: 'abc', detail: 'x'.repeat(400) });
    expect(s.detail).toHaveLength(300);
    expect(events).toEqual([{ type: 'deploy-status', ...s }]);
  });
});
