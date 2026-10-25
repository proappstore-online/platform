import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';

// #381: payouts are archived. Every payout route answers 404 (unregistered),
// even with valid credentials, and developer earnings answer 410. The
// session-key drift check that used to share a file with the payout cron is
// still served.

const TOK = await testToken('gh:1');
const INTERNAL = 'secret-cron-token';
const env = (db?: ReturnType<typeof mockD1>) => makeEnv({ INTERNAL_TOKEN: INTERNAL }, db);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const UNREGISTERED: Array<[string, string, Record<string, string>]> = [
  ['POST', '/v1/connect/onboard', { Authorization: `Bearer ${TOK}` }],
  ['GET', '/v1/connect/status', { Authorization: `Bearer ${TOK}` }],
  ['GET', '/v1/payouts/me/preview', { Authorization: `Bearer ${TOK}` }],
  ['POST', '/v1/internal/payouts/run', { 'X-Internal-Token': INTERNAL }],
  ['POST', '/v1/internal/payouts/backfill-usage', { 'X-Internal-Token': INTERNAL }],
  ['POST', '/v1/internal/payouts/reconcile-ai-gateway', { 'X-Internal-Token': INTERNAL }],
];

describe('payout routes are unreachable (#381)', () => {
  it.each(UNREGISTERED)('%s %s answers 404 and touches nothing', async (method, path, headers) => {
    const db = mockD1();
    globalThis.fetch = vi.fn();
    const res = await app.request(path, { method, headers }, env(db));
    expect(res.status).toBe(404);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled(); // no Stripe call
  });

  it('GET /services/earnings answers 410 before reading anything', async () => {
    const db = mockD1();
    const res = await app.request('/v1/services/earnings', { headers: { Authorization: `Bearer ${TOK}` } }, env(db));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'Payout feature is disabled' });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('GET /internal/session-key-drift is still served', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    const res = await app.request('/v1/internal/session-key-drift', { headers: { 'X-Internal-Token': INTERNAL } },
      env(mockD1(mockStmt({ all: { results: [{ id: 'alpha' }] } }))));
    expect(res.status).toBe(200);
  });
});
