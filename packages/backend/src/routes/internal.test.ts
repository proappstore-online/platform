import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt } from '../test-helpers.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const env = (db?: ReturnType<typeof mockD1>) => makeEnv({ INTERNAL_TOKEN: 'secret-cron-token' }, db);
const drift = (token: string, db?: ReturnType<typeof mockD1>) =>
  app.request('/v1/internal/session-key-drift', { headers: { 'X-Internal-Token': token } }, env(db));

// #70: the on-demand form of the cron drift check (moved out of the archived payout cron, #381).
describe('GET /v1/internal/session-key-drift', () => {
  it('is internal-token only', async () => {
    expect((await drift('wrong')).status).toBe(403);
  });

  it('answers 200 with the report when no sampled worker drifts, 503 when one does', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    const ok = await drift('secret-cron-token', mockD1(mockStmt({ all: { results: [{ id: 'alpha' }] } })));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, sampled: 1, drifted: [], dispatched: [] });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"error":"invalid session"}', { status: 401 }));
    const bad = await drift('secret-cron-token', mockD1(mockStmt({ all: { results: [{ id: 'alpha' }] } })));
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({ ok: false, drifted: ['alpha'] });
  });
});
