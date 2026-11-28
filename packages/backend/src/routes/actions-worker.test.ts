/**
 * Worker-backed actions (#579): an action whose operation is `worker` calls the app's own worker route as the caller,
 * through the same invoke path as a browser request to /.pas/worker. The round trip on a real Worker Loader is covered
 * in runtime-tests; here the host is stubbed and the route's checks and mapping are exercised.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import * as host from '../lib/app-worker-host.js';
import { AppWorkerQuotaError } from '../lib/app-worker-usage.js';
import { verifyCallerGrant } from '../lib/caller-grant.js';
import { TEST_SK } from '../test-helpers.js';

const OWNER = await testToken('gh:1', { login: 'creator', roles: ['user'] });
const MANAGER = await testToken('gh:2', { login: 'manager', roles: ['user'] });
const TOKEN = 'pas_at_' + 'd'.repeat(40);

const worker = (over: Record<string, unknown> = {}) => ({
  name: 'invite_member', description: 'Invite a member to the GitHub org', operation: 'worker', worker: { path: '/actions/invite' },
  params: { org_id: { type: 'string' }, note: { type: 'string', optional: true } }, requires_auth: true,
  auth: { app_roles: ['manager'] }, ...over,
});

interface Seed { manifest?: Record<string, unknown>; roles?: string[]; token?: Record<string, unknown> | null; state?: string }
function db(seed: Seed = {}) {
  const audits: unknown[][] = [];
  const stmt = (sql: string) => {
    let bound: unknown[] = [];
    const st = {
      bind: (...a: unknown[]) => { bound = a; return st; },
      first: async () => {
        if (/FROM app_tools t/.test(sql)) return { manifest: JSON.stringify(seed.manifest ?? worker()), state: seed.state ?? 'live' };
        if (/FROM user_app_tokens/.test(sql)) return seed.token === undefined ? null : seed.token;
        if (/FROM users/.test(sql)) return { login: 'tok', avatar_url: null };
        if (/FROM apps WHERE id/.test(sql)) return { creator_id: 'gh:1' };
        return null;
      },
      all: async () => ({ results: /FROM app_roles/.test(sql) ? (seed.roles ?? []).map((role_name) => ({ role_name })) : [] }),
      run: async () => { if (/app_action_audit/.test(sql)) audits.push(bound); return { meta: { changes: 1 } }; },
    };
    return st;
  };
  return { database: { prepare: (sql: string) => stmt(sql), batch: async () => [] } as unknown as D1Database, audits };
}

const reply = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  ({ invocationId: 'i', httpStatus: 200, status: 'succeeded', body: JSON.stringify({ v: 1, status, headers, body: JSON.stringify(body), body_encoding: 'utf8' }) }) as host.InvokeResult;

function stubWorker(result: host.InvokeResult | Error, active = true) {
  vi.spyOn(host, 'activeAppWorker').mockResolvedValue(active ? ({ app_id: 'interns' } as host.AppWorkerRow) : null);
  const invoke = vi.fn(async () => { if (result instanceof Error) throw result; return result; });
  vi.spyOn(host, 'appWorkerHost').mockReturnValue({ backend: 'loader', invoke, deploy: vi.fn(), remove: vi.fn() } as unknown as host.AppWorkerHost);
  return invoke;
}

function call(seed: Seed, bearer: string, body: Record<string, unknown> = { params: { org_id: 'o1' } }, name = 'invite_member') {
  const d = db(seed);
  return {
    audits: d.audits,
    res: app.request(`/v1/apps/interns/actions/${name}`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, makeEnv({ DB: d.database })),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('worker actions (#579)', () => {
  it('calls the worker route as the signed-in caller and returns the worker\'s JSON body', async () => {
    const invoke = stubWorker(reply(200, { invitation_id: 7, state: 'pending' }));
    const { res, audits } = call({ roles: ['manager'] }, MANAGER);
    const out = await res;
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ invitation_id: 7, state: 'pending' });
    expect(out.headers.get('Cache-Control')).toBe('private, no-store');

    expect(invoke).toHaveBeenCalledTimes(1);
    const [appId, envelope, opts] = invoke.mock.calls[0] as unknown as [string, Record<string, any>, { timeoutMs: number }];
    expect(appId).toBe('interns');
    expect(opts.timeoutMs).toBe(30_000);
    expect(envelope.type).toBe('http');
    expect(envelope.payload).toMatchObject({ method: 'POST', path: '/actions/invite', query: '', headers: { 'content-type': 'application/json' }, body_encoding: 'utf8' });
    expect(JSON.parse(envelope.payload.body)).toEqual({ action: 'invite_member', params: { org_id: 'o1', note: null } });
    // The caller grant names the signed-in user and is bound to this envelope.
    const grant = await verifyCallerGrant({ SESSION_SIGNING_KEY: TEST_SK }, 'interns', envelope.caller, `${envelope.id}:${envelope.attempt}`);
    expect(grant?.id).toBe('gh:2');
    // Audited: actor, role, status — no params, no response.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(['interns', 'invite_member', 'gh:2', 'manager', 0, 200, expect.any(Number), null, null]);
  });

  it('refuses a caller without the app role, before the worker is reached', async () => {
    const invoke = stubWorker(reply(200, {}));
    const out = await call({ roles: [] }, MANAGER).res;
    expect(out.status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses a read-only app token for a write, and runs it for a read_only action as the token user', async () => {
    const invoke = stubWorker(reply(200, { ok: true }));
    const token = { token_id: 'a'.repeat(32), user_id: 'gh:7', app_id: 'interns', scopes: '{"access":"read","actions":null}', expires_at: Date.now() + 60_000, revoked_at: null };
    const refused = await call({ manifest: worker({ auth: undefined }), token }, TOKEN).res;
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('token is read-only');
    expect(invoke).not.toHaveBeenCalled();

    const ok = await call({ manifest: worker({ auth: undefined, read_only: true }), token }, TOKEN).res;
    expect(ok.status).toBe(200);
    const envelope = invoke.mock.calls[0]![1] as unknown as Record<string, any>;
    expect((await verifyCallerGrant({ SESSION_SIGNING_KEY: TEST_SK }, 'interns', envelope.caller, `${envelope.id}:${envelope.attempt}`))?.id).toBe('gh:7');
  });

  it('refuses an action that needs step-up with an app token', async () => {
    stubWorker(reply(200, {}));
    const token = { token_id: 'a'.repeat(32), user_id: 'gh:7', app_id: 'interns', scopes: '{"access":"write","actions":null}', expires_at: Date.now() + 60_000, revoked_at: null };
    expect((await call({ manifest: worker({ auth: undefined, step_up: true }), token }, TOKEN).res).status).toBe(403);
  });

  it('validates params with the SQL-action rules: 400 on a missing one or an undeclared one (#600); only declared ones reach the worker', async () => {
    const invoke = stubWorker(reply(200, {}));
    const missing = await call({ roles: ['manager'] }, MANAGER, { params: {} }).res;
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('Missing required parameter: org_id');
    expect((await call({ roles: ['manager'] }, MANAGER, { params: 'x' }).res).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();

    const undeclared = await call({ roles: ['manager'] }, MANAGER, { params: { org_id: 'o1', extra: 'x' } }).res;
    expect(undeclared.status).toBe(400);
    expect(((await undeclared.json()) as { error: string }).error).toMatch(/^Unknown parameter: extra\./);
    expect(invoke).not.toHaveBeenCalled();

    await call({ roles: ['manager'] }, MANAGER, { params: { org_id: 'o1' } }).res;
    const envelope = invoke.mock.calls[0]![1] as unknown as { payload: { body: string } };
    expect(JSON.parse(envelope.payload.body).params).toEqual({ org_id: 'o1', note: null });
  });

  it('dry_run validates for the app team and never reaches the worker; others are refused', async () => {
    const invoke = stubWorker(reply(200, {}));
    const { res, audits } = call({ manifest: worker({ auth: undefined }) }, OWNER, { params: { org_id: 'o1' }, dry_run: true });
    const dry = await res;
    expect(dry.status).toBe(200);
    expect(audits).toHaveLength(0);
    expect(await dry.json()).toEqual({ dry_run: true, state: 'live' });
    expect((await call({ manifest: worker({ auth: undefined }) }, OWNER, { params: {}, dry_run: true }).res).status).toBe(400);
    expect((await call({ manifest: worker({ auth: undefined }) }, MANAGER, { params: { org_id: 'o1' }, dry_run: true }).res).status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('is a clear 409 when the app has no enabled worker', async () => {
    const invoke = stubWorker(reply(200, {}), false);
    const out = await call({ roles: ['manager'] }, MANAGER).res;
    expect(out.status).toBe(409);
    expect(((await out.json()) as { error: string }).error).toMatch(/no enabled, deployed app worker/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes a worker 4xx/5xx through with its status and JSON error, and records no success audit', async () => {
    for (const status of [403, 422, 500]) {
      stubWorker(reply(status, { error: `worker said ${status}` }));
      const { res, audits } = call({ roles: ['manager'] }, MANAGER);
      const out = await res;
      expect(out.status).toBe(status);
      expect(await out.json()).toEqual({ error: `worker said ${status}` });
      expect(audits).toHaveLength(0);
    }
  });

  it('maps quota to 429 + Retry-After, a timeout to 504 and a malformed reply to 502', async () => {
    stubWorker(new AppWorkerQuotaError('requests' as never, Date.now()));
    const quota = await call({ roles: ['manager'] }, MANAGER).res;
    expect(quota.status).toBe(429);
    expect(Number(quota.headers.get('Retry-After'))).toBeGreaterThan(0);

    stubWorker({ invocationId: 'i', httpStatus: null, status: 'timeout', body: null });
    expect((await call({ roles: ['manager'] }, MANAGER).res).status).toBe(504);

    stubWorker({ invocationId: 'i', httpStatus: 200, status: 'succeeded', body: 'not an envelope' });
    expect((await call({ roles: ['manager'] }, MANAGER).res).status).toBe(502);
    stubWorker({ invocationId: 'i', httpStatus: 200, status: 'succeeded', body: JSON.stringify({ v: 2, status: 200 }) });
    expect((await call({ roles: ['manager'] }, MANAGER).res).status).toBe(502);
  });

  it('a sensitive action is audited by tool, actor, time and outcome only: no params or response reach the audit row or the logs', async () => {
    stubWorker(reply(200, { tfn: '123 456 782' }));
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const { res, audits } = call({ manifest: worker({ name: 'reveal_tfn', sensitive: true, read_only: true, params: { entity_id: { type: 'string' } }, auth: undefined }), roles: [] }, MANAGER, { params: { entity_id: 'SECRET-ENTITY' } }, 'reveal_tfn');
    const out = await res;
    expect(await out.json()).toEqual({ tfn: '123 456 782' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(['interns', 'reveal_tfn', 'gh:2', '', 0, 200, expect.any(Number), null, null]);
    expect(JSON.stringify([audits, ...logs.map((l) => l.mock.calls)])).not.toMatch(/SECRET-ENTITY|123 456 782/);
  });
});
