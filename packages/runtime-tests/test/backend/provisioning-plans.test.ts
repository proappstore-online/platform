import { SELF, env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, resetTables, seedUser, session } from './helpers';
import { PLAN_RETENTION_MS, pruneProvisioningPlans } from '../../../backend/src/routes/provisioning-plans';

const env = testEnv as unknown as Env;

// #367 on real D1: the Console's preview → confirm protocol through the real
// routes. The MCP side is the runtime stub (stubs/mcp-broker.js); the workflow
// itself is unit-tested in packages/mcp. This proves the plan table: binding to
// the user, expiry, the single-flight claim, and joining the receipt.

const input = (appId: string) => ({ appId, name: 'App', description: 'An app.', template: 'template-app', repoUrl: `https://github.com/proappstore-online/${appId}` });
async function preview(appId: string, uid = 'gh:1') {
  const res = await SELF.fetch(`${BASE}/v1/provisioning/plans`, json('POST', input(appId), await session(uid)));
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json() as Promise<{ planId: string; expiresAt: number; plan: { appId: string; blockers: unknown[] } }>;
}
const confirm = async (planId: string, uid = 'gh:1') =>
  SELF.fetch(`${BASE}/v1/provisioning/plans/${planId}/confirm`, json('POST', {}, await session(uid)));
const row = (planId: string) => env.DB.prepare('SELECT user_id, app_id, expires_at, executing_until, receipt_id, confirmed_at FROM provisioning_plans WHERE plan_id = ?')
  .bind(planId).first<{ user_id: string; app_id: string; expires_at: number; executing_until: number | null; receipt_id: string | null; confirmed_at: number | null }>();

beforeEach(async () => {
  await resetTables();
  for (const t of ['provisioning_plans', 'provision_operations', 'provision_attempts']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1');
  await seedUser('gh:2');
});

describe('provisioning plans on real D1 (#367)', () => {
  it('a preview is stored bound to its user, and expires after ten minutes', async () => {
    const before = Date.now();
    const { planId, expiresAt, plan } = await preview('plan-one');
    expect(plan).toMatchObject({ appId: 'plan-one', blockers: [] });
    expect(await row(planId)).toMatchObject({ user_id: 'gh:1', app_id: 'plan-one', executing_until: null, receipt_id: null });
    expect(expiresAt - before).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
    expect((await confirm(planId, 'gh:2')).status).toBe(404);

    await env.DB.prepare('UPDATE provisioning_plans SET expires_at = ? WHERE plan_id = ?').bind(Date.now() - 1, planId).run();
    const expired = await confirm(planId);
    expect(expired.status).toBe(410);
    expect(await row(planId)).toMatchObject({ executing_until: null, receipt_id: null });
  });

  it('concurrent confirmations: exactly one executes, the other joins (202); the receipt is recorded once', async () => {
    const { planId } = await preview('plan-two');
    const [a, b] = await Promise.all([confirm(planId), confirm(planId)]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    const done = [a, b].find((r) => r.status === 200)!;
    expect(await done.json()).toMatchObject({ planId, receipt: 'stub-receipt-plan-two', repoAction: 'created', succeeded: true });
    expect(await row(planId)).toMatchObject({ receipt_id: 'stub-receipt-plan-two', executing_until: null, confirmed_at: expect.any(Number) });
  });

  it('once its receipt is running or done, a repeat joins it without executing, even after expiry', async () => {
    const { planId } = await preview('plan-three');
    expect((await confirm(planId)).status).toBe(200);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO provision_operations (receipt_id, creator_id, app_id, intent_hash, bootstrap_intent_hash, status, steps_json, attempt_count, lease_expires_at, attempt_id, created_at, updated_at, completed_at)
       VALUES ('stub-receipt-plan-three', 'gh:1', 'plan-three', 'i', 'b', 'completed', '[]', 1, NULL, NULL, ?, ?, ?)`,
    ).bind(now, now, now).run();
    await env.DB.prepare('UPDATE provisioning_plans SET expires_at = ? WHERE plan_id = ?').bind(now - 1, planId).run();
    const again = await confirm(planId);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ planId, receipt: 'stub-receipt-plan-three', status: 'completed', joined: true });
  });

  it('a changed plan answers 409 with the fresh plan and leaves the plan confirmable', async () => {
    const { planId } = await preview('changed-four');
    const res = await confirm(planId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'plan_changed', plan: { template: { revision: 'b'.repeat(40) } } });
    expect(await row(planId)).toMatchObject({ executing_until: null, receipt_id: null });
  });

  it('a blocked plan is stored for display but never executes', async () => {
    const { planId, plan } = await preview('blocked-five');
    expect(plan.blockers).toHaveLength(1);
    expect((await confirm(planId)).status).toBe(422);
    expect(await row(planId)).toMatchObject({ executing_until: null, receipt_id: null });
  });
});

describe('#374 on real D1: previews are metered apart from provisioning, and old plans are pruned', () => {
  it('a preview spends only preview buckets, never a provisioning attempt', async () => {
    await preview('metered-one');
    const keys = ((await env.DB.prepare('SELECT key FROM provision_attempts').all<{ key: string }>()).results ?? []).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('user:preview:') || k.startsWith('ip:preview:'))).toBe(true);
  });

  it('the prune deletes only plans past expiry plus retention that hold no live lease', async () => {
    const now = Date.now();
    const old = now - PLAN_RETENTION_MS - 1;
    const ids = { gone: (await preview('prune-a')).planId, recent: (await preview('prune-b')).planId, leased: (await preview('prune-c')).planId };
    const set = (id: string, expires: number, lease: number | null) =>
      env.DB.prepare('UPDATE provisioning_plans SET expires_at = ?, executing_until = ? WHERE plan_id = ?').bind(expires, lease, id).run();
    await set(ids.gone, old, now - 1);
    await set(ids.recent, now - 1, null);
    await set(ids.leased, old, now + 60_000);
    expect(await pruneProvisioningPlans(env.DB, now)).toBe(1);
    expect(await row(ids.gone)).toBeNull();
    expect(await row(ids.recent)).not.toBeNull();
    expect(await row(ids.leased)).not.toBeNull();
  });
});
