import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';

type Row = {
  receipt_id: string;
  creator_id: string;
  app_id: string;
  status: string;
  steps_json: string;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

/** Minimal D1 model for the receipt endpoints; it never creates app data. */
function operationDb() {
  const byApp = new Map<string, Row>();
  const byReceipt = new Map<string, Row>();
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() {
          if (/FROM apps\b/i.test(sql)) return null;
          if (/WHERE app_id = \?/i.test(sql)) return byApp.get(String(values[0])) ?? null;
          if (/WHERE receipt_id = \?/i.test(sql)) return byReceipt.get(String(values[0])) ?? null;
          return null;
        },
        async run() {
          if (/INSERT OR IGNORE INTO provision_operations/i.test(sql)) {
            const [receipt, creator, appId, createdAt, updatedAt] = values as [string, string, string, number, number];
            if (byApp.has(appId)) return { meta: { changes: 0 } };
            const row: Row = {
              receipt_id: receipt, creator_id: creator, app_id: appId, status: 'pending', steps_json: '[]', result_json: null,
              created_at: createdAt, updated_at: updatedAt, completed_at: null,
            };
            byApp.set(appId, row); byReceipt.set(receipt, row);
            return { meta: { changes: 1 } };
          }
          if (/UPDATE provision_operations/i.test(sql)) {
            const [status, steps, result, updatedAt, completedAt, receipt] = values as [string, string, string | null, number, number | null, string];
            const row = byReceipt.get(receipt);
            if (row) Object.assign(row, { status, steps_json: steps, result_json: result, updated_at: updatedAt, completed_at: completedAt });
            return { meta: { changes: row ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  } as unknown as D1Database;
}

const ownerToken = await testToken('gh:owner', { roles: ['user'] });
const otherToken = await testToken('gh:other', { roles: ['user'] });
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

describe('durable provision receipts (#358)', () => {
  it('creates one receipt for concurrent retries, retains evidence, and completes after the interrupted response', async () => {
    const env = makeEnv({}, operationDb());
    const request = () => app.request('/v1/provision-operations', {
      method: 'POST', headers: headers(ownerToken), body: JSON.stringify({ appId: 'interrupted-app' }),
    }, env);
    const [first, retry] = await Promise.all([request(), request()]);
    const firstData = await first.json() as { receipt: string; status: string };
    const retryData = await retry.json() as { receipt: string; status: string; joined: boolean };
    expect([first.status, retry.status].sort()).toEqual([200, 201]);
    expect(firstData.receipt).toBe(retryData.receipt);
    expect(retryData.status).toBe('pending');
    expect(retryData.joined || first.status === 200).toBe(true);

    const patched = await app.request('/v1/provision-operations/interrupted-app', {
      method: 'PATCH', headers: headers(ownerToken),
      body: JSON.stringify({
        status: 'completed',
        steps: [
          { name: 'repo_created', status: 'ok', detail: 'repo created' },
          { name: 'config_committed', status: 'ok', detail: 'configuration commit created' },
          { name: 'compliance', status: 'ok', detail: 'passed' },
          { name: 'r2_deploy', status: 'ok', detail: 'route configured' },
          { name: 'host', status: 'ok', detail: '200' },
        ],
      }),
    }, env);
    expect(patched.status).toBe(200);

    const status = await app.request('/v1/provision-operations/interrupted-app', { headers: headers(ownerToken) }, env);
    const data = await status.json() as { receipt: string; status: string; steps: { name: string }[] };
    expect(data).toMatchObject({ receipt: firstData.receipt, status: 'completed' });
    expect(data.steps.map((step) => step.name)).toEqual(expect.arrayContaining([
      'repo_created', 'config_committed', 'compliance', 'r2_deploy', 'host',
    ]));
  });

  it('does not disclose or join a pending receipt owned by another caller', async () => {
    const env = makeEnv({}, operationDb());
    await app.request('/v1/provision-operations', {
      method: 'POST', headers: headers(ownerToken), body: JSON.stringify({ appId: 'owned-app' }),
    }, env);
    const retry = await app.request('/v1/provision-operations', {
      method: 'POST', headers: headers(otherToken), body: JSON.stringify({ appId: 'owned-app' }),
    }, env);
    expect(retry.status).toBe(403);
    const status = await app.request('/v1/provision-operations/owned-app', { headers: headers(otherToken) }, env);
    expect(status.status).toBe(403);
  });
});
