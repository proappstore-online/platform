import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #501 through the real API on real D1: an app trigger's APP:<code> reaches the caller as an app.<code>
// errorCode, and a 500 tenant fault leaves SQLite's text in the owner's operation log, not in the response.
// Only the app's data worker is intercepted.

const addEntry = {
  name: 'add_entry', description: 'Add an entry', operation: 'execute', requires_auth: true, params: { body: { type: 'string' } },
  sql: 'INSERT INTO entries (user_id, body) VALUES (:__user_id, :body)',
};
const owner = () => session('gh:admin', { roles: ['user', 'admin'] });
const dataWorker = () => fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`);

async function register(): Promise<void> {
  dataWorker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/club/tools`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await owner()}` }, body: JSON.stringify({ tools: [addEntry] }) });
  expect(res.status).toBe(200);
}
const callAdd = async () => SELF.fetch(`${BASE}/v1/apps/club/actions/add_entry`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await owner()}` }, body: JSON.stringify({ params: { body: 'x' } }),
});
const serverRows = async () => (await env.DB.prepare("SELECT message FROM app_logs WHERE app_id = 'club' AND source = 'server'").all<{ message: string }>()).results ?? [];
/** The row is written after the response, in the background. */
async function waitForRow(): Promise<{ message: string }[]> {
  for (let i = 0; i < 50; i++) {
    const rows = await serverRows();
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  await env.DB.prepare('UPDATE app_worker_platform SET open = 1, closed_reason = NULL, closed_at = NULL').run();
  await seedUser('gh:admin', 'admin');
  await env.DB.prepare('DELETE FROM app_go_live').run();
  await seedApp('club', 'gh:admin');
});

describe('app trigger error codes through the API (#501)', () => {
  it("relays a trigger's APP: code to the caller as app.<code>, with the generic text of the data worker", async () => {
    await register();
    dataWorker().intercept({ path: '/execute', method: 'POST' })
      .reply(422, { error: 'action rejected by the app', errorCode: 'app.sensitive_input' }, { headers: { 'Content-Type': 'application/json' } });
    const res = await callAdd();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'action rejected by the app', errorCode: 'app.sensitive_input' });
  });

  it('records the SQLite text of a 500 tenant fault in the owner-visible log, and never in the response', async () => {
    await register();
    dataWorker().intercept({ path: '/execute', method: 'POST' })
      .reply(500, { error: 'internal server error' }, { headers: { 'Content-Type': 'application/json', 'X-PAS-Fault': 'tenant', 'X-PAS-Fault-Detail': 'no such column: totl_cents: SQLITE_ERROR' } });
    const res = await callAdd();
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('totl_cents');
    expect(res.headers.get('X-PAS-Fault-Detail')).toBeNull();

    const rows = await waitForRow();
    expect(rows.length).toBe(1);
    expect(rows[0]!.message).toContain('data worker returned 500 (tenant fault)');
    expect(rows[0]!.message).toContain('no such column: totl_cents');
  });

  it('a 500 without a detail (an older data worker, or a platform fault) is recorded as before', async () => {
    await register();
    dataWorker().intercept({ path: '/execute', method: 'POST' })
      .reply(500, { error: 'internal server error' }, { headers: { 'Content-Type': 'application/json', 'X-PAS-Fault': 'tenant' } });
    expect((await callAdd()).status).toBe(500);
    const rows = await waitForRow();
    expect(rows[0]?.message).toBe('data worker returned 500 (tenant fault)');
  });
});
