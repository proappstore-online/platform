import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { EXECUTION_LEASE_MS, PLAN_TTL_MS } from './provisioning-plans.js';

// #367: the Console's preview/confirm routes over an in-memory model of the two
// tables they touch (provisioning_plans, provision_operations) and a mocked MCP
// service binding. Real-D1 behaviour is runtime-tests/test/backend/provisioning-plans.test.ts.

const OWNER = await testToken('gh:1');
const OTHER = await testToken('gh:2');
const APP = 'school-clubs';
const REPO_URL = `https://github.com/proappstore-online/${APP}`;
const body = { appId: APP, name: 'School Clubs', description: 'Clubs.', template: 'template-marketplace', repoUrl: REPO_URL };
const plan = (blockers: unknown[] = []) => ({ version: 1, appId: APP, action: 'create', blockers, template: { id: 'template-marketplace', revision: 'a'.repeat(40) } });

type PlanRow = Record<string, unknown> & { plan_id: string; executing_until: number | null; receipt_id: string | null; confirmed_at: number | null };
let plans: Map<string, PlanRow>;
let operations: Map<string, Record<string, unknown>>;

function fakeDb() {
  return {
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, ' ').trim();
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (s.startsWith('SELECT plan_id')) return plans.get(String(args[0])) ?? null;
          if (s.startsWith('SELECT receipt_id')) return operations.get(String(args[0])) ?? null;
          throw new Error(`unexpected first(): ${s}`);
        },
        async run() {
          if (s.startsWith('INSERT INTO provisioning_plans')) {
            const [plan_id, user_id, app_id, input_json, plan_json, created_at, expires_at] = args as [string, string, string, string, string, number, number];
            plans.set(plan_id, { plan_id, user_id, app_id, input_json, plan_json, created_at, expires_at, executing_until: null, receipt_id: null, confirmed_at: null });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE provisioning_plans SET executing_until = ? WHERE')) {
            // The conditional claim: a single synchronous step, as one SQLite statement is.
            const [until, id, user, now] = args as [number, string, string, number];
            const row = plans.get(id);
            if (!row || row.user_id !== user || (row.executing_until !== null && row.executing_until > now)) return { meta: { changes: 0 } };
            row.executing_until = until;
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE provisioning_plans SET executing_until = NULL')) {
            plans.get(String(args[0]))!.executing_until = null;
            return { meta: { changes: 1 } };
          }
          if (s.startsWith('UPDATE provisioning_plans SET receipt_id')) {
            const row = plans.get(String(args[2]))!;
            row.receipt_id = String(args[0]);
            row.confirmed_at ??= Number(args[1]);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${s}`);
        },
      };
      return stmt;
    },
  };
}

function operation(status: string, creator = 'gh:1') {
  operations.set(APP, {
    receipt_id: 'receipt-1', creator_id: creator, app_id: APP, intent_hash: 'i', bootstrap_intent_hash: 'b', status,
    steps_json: JSON.stringify([{ name: 'repo_created', status: 'ok', detail: 'created', completedAt: 1, attemptId: 'a1' }]),
    result_json: status === 'completed' ? JSON.stringify({ success: true, appUrl: `https://${APP}.proappstore.online` }) : null,
    attempt_count: 1, lease_expires_at: Date.now() + 60_000, attempt_id: 'a1', created_at: 1, updated_at: 2, completed_at: status === 'pending' ? null : 3,
  });
}

let mcp: ReturnType<typeof vi.fn>;
let execute: (plan: unknown) => Promise<Response>;
const mcpCalls = (step: string) => mcp.mock.calls.filter((c) => String(c[0]).endsWith(`/internal/provisioning/${step}`));
function env(over: Record<string, unknown> = {}) {
  return makeEnv({ INTERNAL_TOKEN: 'internal-secret', MCP: { fetch: mcp }, ...over }, fakeDb() as never);
}
const post = (path: string, json: unknown, tok = OWNER, e = env()) =>
  app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(json) }, e);
async function createPlan(p = plan(), e = env()) {
  mcp.mockImplementationOnce(async () => Response.json({ plan: p }));
  const res = await post('/v1/provisioning/plans', body, OWNER, e);
  expect(res.status).toBe(201);
  return (await res.json() as { planId: string }).planId;
}
const confirm = (planId: string, tok = OWNER, e = env()) => post(`/v1/provisioning/plans/${planId}/confirm`, {}, tok, e);

beforeEach(() => {
  plans = new Map();
  operations = new Map();
  execute = async () => { operation('completed'); return Response.json({ joined: false, receipt: 'receipt-1', repoAction: 'created', succeeded: true, lines: ['+ GitHub repo: created'] }); };
  mcp = vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/internal/provisioning/execute')) return execute(JSON.parse(String(init.body)).plan);
    return Response.json({ plan: plan() });
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('POST /v1/provisioning/plans (preview)', () => {
  it('forwards the exact input with the internal token and the caller\'s session, then stores the plan bound to them', async () => {
    const res = await post('/v1/provisioning/plans', { ...body, templateRev: 'abc1234' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const data = await res.json() as { planId: string; expiresAt: number; plan: unknown };
    expect(data.plan).toEqual(plan());
    expect(data.expiresAt - Date.now()).toBeGreaterThan(PLAN_TTL_MS - 5_000);
    const [url, init] = mcpCalls('plan')[0]!;
    expect(String(url)).toBe('https://mcp/internal/provisioning/plan');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Internal-Token': 'internal-secret', 'X-PAS-Session': OWNER });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ input: { ...body, templateRev: 'abc1234' } });
    expect(plans.get(data.planId)).toMatchObject({ user_id: 'gh:1', app_id: APP, receipt_id: null });
    expect(mcpCalls('execute')).toEqual([]);
  });

  it('refuses malformed input before asking the workflow anything', async () => {
    for (const [over, message] of [
      [{ appId: 'Bad_Id' }, /Invalid app ID/],
      [{ template: undefined }, /template is required/],
      [{ name: '' }, /name is required/],
      [{ repoUrl: 'https://github.com/attacker/repo' }, /repoUrl must be https:\/\/github.com\/proappstore-online\/school-clubs/],
      [{ repoUrl: undefined }, /repoUrl must be/],
      [{ templateRev: 'HEAD' }, /templateRev must be a git object id/],
    ] as [Record<string, unknown>, RegExp][]) {
      const res = await post('/v1/provisioning/plans', { ...body, ...over });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await res.text()).toMatch(message);
    }
    expect(mcp).not.toHaveBeenCalled();
    expect(plans.size).toBe(0);
  });

  it('passes the workflow\'s refusals through as 400, and stores nothing on an unusable answer', async () => {
    mcp.mockImplementationOnce(async () => Response.json({ error: 'unknown template "x"' }, { status: 400 }));
    expect((await post('/v1/provisioning/plans', body)).status).toBe(400);
    mcp.mockImplementationOnce(async () => Response.json({ plan: { ...plan(), appId: 'another-app' } }));
    expect((await post('/v1/provisioning/plans', body)).status).toBe(502);
    expect((await post('/v1/provisioning/plans', body, OWNER, env({ MCP: undefined }))).status).toBe(503);
    expect(plans.size).toBe(0);
  });

  it('requires a signed-in session', async () => {
    const res = await app.request('/v1/provisioning/plans', { method: 'POST', body: JSON.stringify(body) }, env());
    expect(res.status).toBe(401);
    expect(mcp).not.toHaveBeenCalled();
  });
});

describe('POST /v1/provisioning/plans/:planId/confirm', () => {
  it('executes the stored plan once and answers with the durable receipt', async () => {
    const id = await createPlan();
    const res = await confirm(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      planId: id, receipt: 'receipt-1', appId: APP, status: 'completed', joined: false, repoAction: 'created', succeeded: true,
      result: { success: true }, log: ['+ GitHub repo: created'],
    });
    expect(mcpCalls('execute')).toHaveLength(1);
    expect(JSON.parse(String((mcpCalls('execute')[0]![1] as RequestInit).body))).toEqual({ plan: plan() });
    expect(plans.get(id)).toMatchObject({ receipt_id: 'receipt-1', executing_until: null });
  });

  it('someone else\'s plan, or no plan, is a 404 and runs nothing', async () => {
    const id = await createPlan();
    expect((await confirm(id, OTHER)).status).toBe(404);
    expect((await confirm('nope')).status).toBe(404);
    expect(mcpCalls('execute')).toEqual([]);
  });

  it('an expired plan must be previewed again', async () => {
    const id = await createPlan();
    plans.get(id)!.expires_at = Date.now() - 1;
    const res = await confirm(id);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'plan_expired' });
    expect(mcpCalls('execute')).toEqual([]);
  });

  it('a plan with blockers is never sent for execution', async () => {
    const id = await createPlan(plan([{ code: 'owned_by_another_account', message: 'x' }]));
    const res = await confirm(id);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'plan_blocked' });
    expect(mcpCalls('execute')).toEqual([]);
  });

  it('a changed plan answers 409 with the fresh plan, and the plan can be confirmed again later', async () => {
    const id = await createPlan();
    const fresh = { ...plan(), template: { id: 'template-marketplace', revision: 'b'.repeat(40) } };
    execute = async () => Response.json({ error: 'plan_changed', plan: fresh }, { status: 409 });
    const res = await confirm(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'plan_changed', plan: fresh });
    expect(plans.get(id)).toMatchObject({ receipt_id: null, executing_until: null });
  });

  it('concurrent confirmations: one execution, the other joins (202) the receipt in flight', async () => {
    const id = await createPlan();
    let release!: () => void;
    execute = async () => {
      operation('pending');
      await new Promise<void>((r) => { release = r; });
      operation('completed');
      return Response.json({ joined: false, receipt: 'receipt-1', repoAction: 'created', succeeded: true, lines: [] });
    };
    const first = confirm(id);
    await vi.waitFor(() => expect(mcpCalls('execute')).toHaveLength(1));
    const second = await confirm(id);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ planId: id, receipt: 'receipt-1', status: 'pending', joined: true });
    release();
    expect((await first).status).toBe(200);
    expect(mcpCalls('execute')).toHaveLength(1);
  });

  it('a repeat after completion joins the receipt without executing again, even once the preview has expired', async () => {
    const id = await createPlan();
    expect((await confirm(id)).status).toBe(200);
    plans.get(id)!.expires_at = Date.now() - 1;
    const again = await confirm(id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ receipt: 'receipt-1', status: 'completed', joined: true });
    expect(mcpCalls('execute')).toHaveLength(1);
  });

  it('a stale execution lease (a crashed confirmation) does not block a new one', async () => {
    const id = await createPlan();
    plans.get(id)!.executing_until = Date.now() - 1;
    expect((await confirm(id)).status).toBe(200);
    plans.get(id)!.receipt_id = null;
    plans.get(id)!.executing_until = Date.now() + EXECUTION_LEASE_MS;
    expect((await confirm(id)).status).toBe(202);
  });

  it('surfaces an execution failure after the receipt was taken with the receipt\'s honest state', async () => {
    const id = await createPlan();
    execute = async () => { operation('failed'); return Response.json({ joined: false, receipt: 'receipt-1', error: 'Error creating repo: boom' }); };
    const res = await confirm(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'Error creating repo: boom' });
    execute = async () => Response.json({ error: 'Error: could not start durable provisioning receipt' }, { status: 503 });
    const id2 = await createPlan();
    expect((await confirm(id2)).status).toBe(503);
  });
});
