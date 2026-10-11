import { createExecutionContext, env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_FLOWS_PER_APP } from '../../../qa-spec/src/types';
import worker from '../../../backend/src/index';
import type { Env } from '../../../backend/src/types';
import { BASE, json, resetTables, seedApp, seedUser, session } from './helpers';

const env = testEnv as unknown as Env;

// #364 (#303 N21) on real D1: the per-app QA flow cap is checked inside the
// admitting INSERT. The handler runs in-process on the real binding, so parallel
// PUTs interleave at every await the way concurrent requests do.

const flow = (id: string) => ({ id, name: `Flow ${id}`, steps: [{ op: 'expectText', text: 'Sign in' }] });
const put = async (id: string) => worker.fetch(
  new Request(`${BASE}/v1/apps/qaapp/qa/flows/${id}`, json('PUT', { flow: flow(id) }, await session('gh:owner'))),
  env,
  createExecutionContext(),
);
const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM app_test_flows WHERE app_id = 'qaapp'").first<{ n: number }>())!.n;
const seedFlows = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare("INSERT INTO app_test_flows (app_id, flow_id, name, spec, updated_by, updated_at) VALUES ('qaapp', ?, 'seed', ?, 'gh:owner', 1)")
      .bind(`seed-${i}`, JSON.stringify(flow(`seed-${i}`))).run();
  }
};

beforeEach(async () => {
  await resetTables();
  await env.DB.prepare('DELETE FROM app_test_flows').run();
  await seedUser('gh:owner');
  await seedApp('qaapp', 'gh:owner');
});

describe(`per-app QA flow cap of ${MAX_FLOWS_PER_APP} (#364)`, () => {
  it('parallel creates of distinct new flows admit exactly the cap', async () => {
    const res = await Promise.all(Array.from({ length: MAX_FLOWS_PER_APP + 10 }, (_, i) => put(`new-${i}`)));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_FLOWS_PER_APP);
    expect(statuses.filter((s) => s === 400)).toHaveLength(10);
    const refused = res.find((r) => r.status === 400)!;
    expect(await refused.text()).toContain(`at most ${MAX_FLOWS_PER_APP} flows`);
    expect(await count()).toBe(MAX_FLOWS_PER_APP);
  });

  it('boundary: the last slot is admitted, the next new flow is refused and writes nothing', async () => {
    await seedFlows(MAX_FLOWS_PER_APP - 1);
    expect((await put('last')).status).toBe(200);
    expect(await count()).toBe(MAX_FLOWS_PER_APP);
    const over = await put('one-too-many');
    expect(over.status).toBe(400);
    expect(await over.text()).toContain(`at most ${MAX_FLOWS_PER_APP} flows`);
    expect(await count()).toBe(MAX_FLOWS_PER_APP);
  });

  it('at the cap an existing flow is still updatable, and a deleted slot can be reused', async () => {
    await seedFlows(MAX_FLOWS_PER_APP);
    expect((await put('seed-3')).status).toBe(200);
    expect((await env.DB.prepare("SELECT name FROM app_test_flows WHERE app_id = 'qaapp' AND flow_id = 'seed-3'").first<{ name: string }>())!.name).toBe('Flow seed-3');
    expect((await put('fresh')).status).toBe(400);
    await env.DB.prepare("DELETE FROM app_test_flows WHERE app_id = 'qaapp' AND flow_id = 'seed-0'").run();
    expect((await put('fresh')).status).toBe(200);
    expect(await count()).toBe(MAX_FLOWS_PER_APP);
  });

  it('an app already over the cap (from the old race) can still update its flows, but not add one', async () => {
    await seedFlows(MAX_FLOWS_PER_APP + 2);
    expect((await put('seed-0')).status).toBe(200);
    expect((await put('fresh')).status).toBe(400);
    expect(await count()).toBe(MAX_FLOWS_PER_APP + 2);
  });
});
