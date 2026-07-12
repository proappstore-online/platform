import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 1 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt({ run: { meta: { changes: 1 } } }));
  return { prepare };
}

function makeEnv(db: ReturnType<typeof mockD1>) {
  return {
    DB: db as unknown as D1Database,
    STORAGE: { put: vi.fn() } as unknown as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
  };
}

const ownerStmt = () => mockStmt({ first: { creator_id: 'gh:1' } });

const validFlow = {
  id: 'sign-in',
  name: 'Sign-in page renders',
  steps: [{ op: 'expectText', text: 'Sign in' }],
};

function req(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  return new Request(`https://api.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', ...headers },
  });
}

describe('PUT /v1/apps/:appId/qa/flows/:flowId', () => {
  it('stores a validated flow for the owner', async () => {
    // stmts: owner lookup, count, upsert
    const upsert = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(ownerStmt(), mockStmt({ first: { n: 0 } }), upsert);
    const res = await app.request(
      req('/v1/apps/chess-academy/qa/flows/sign-in', { method: 'PUT', body: JSON.stringify({ flow: validFlow }) }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(200);
    expect(upsert.bind).toHaveBeenCalledWith(
      'chess-academy', 'sign-in', 'Sign-in page renders', JSON.stringify(validFlow), 'gh:1', expect.any(Number),
    );
  });

  it('rejects an invalid spec with the validation message', async () => {
    const db = mockD1(ownerStmt());
    const res = await app.request(
      req('/v1/apps/chess-academy/qa/flows/sign-in', {
        method: 'PUT',
        body: JSON.stringify({ flow: { ...validFlow, steps: [{ op: 'teleport' }] } }),
      }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('teleport');
  });

  it('rejects a flow id mismatch and enforces the per-app flow cap', async () => {
    const db = mockD1(ownerStmt());
    const mismatch = await app.request(
      req('/v1/apps/chess-academy/qa/flows/other-id', { method: 'PUT', body: JSON.stringify({ flow: validFlow }) }),
      undefined, makeEnv(db) as never,
    );
    expect(mismatch.status).toBe(400);

    const db2 = mockD1(ownerStmt(), mockStmt({ first: { n: 20 } }));
    const capped = await app.request(
      req('/v1/apps/chess-academy/qa/flows/sign-in', { method: 'PUT', body: JSON.stringify({ flow: validFlow }) }),
      undefined, makeEnv(db2) as never,
    );
    expect(capped.status).toBe(400);
    expect(await capped.text()).toContain('at most');
  });

  it('403s for a non-owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:someone-else' } }), mockStmt({ first: null }));
    const res = await app.request(
      req('/v1/apps/chess-academy/qa/flows/sign-in', { method: 'PUT', body: JSON.stringify({ flow: validFlow }) }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(403);
  });
});

describe('QA key auth', () => {
  it('accepts a valid, unrevoked QA key without a bearer token', async () => {
    // stmts: qa key lookup, flows list
    const db = mockD1(
      mockStmt({ first: { app_id: 'chess-academy' } }),
      mockStmt({ all: { results: [{ flow_id: 'sign-in', name: 'n', spec: JSON.stringify(validFlow), updated_by: 'x', updated_at: 1 }] } }),
    );
    const res = await app.request(
      new Request('https://api.test/v1/apps/chess-academy/qa/flows', { headers: { 'X-QA-Key': 'qak_abc' } }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flows: Array<{ spec: { id: string } }> };
    expect(body.flows[0].spec.id).toBe('sign-in');
  });

  it('rejects an unknown/revoked QA key', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request(
      new Request('https://api.test/v1/apps/chess-academy/qa/flows', { headers: { 'X-QA-Key': 'qak_bad' } }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(403);
  });

  it('never allows a QA key to mint keys', async () => {
    const db = mockD1();
    const res = await app.request(
      new Request('https://api.test/v1/apps/chess-academy/qa/keys', { method: 'POST', headers: { 'X-QA-Key': 'qak_abc' } }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(401); // no bearer → requireAppOwner fails
  });
});

describe('runs', () => {
  it('queues a run per flow and returns run ids', async () => {
    const insert = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(
      ownerStmt(),
      mockStmt({ all: { results: [{ flow_id: 'a' }, { flow_id: 'b' }] } }),
      insert, insert,
    );
    const res = await app.request(
      req('/v1/apps/chess-academy/qa/runs', { method: 'POST', body: JSON.stringify({}) }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ flowId: string }> };
    expect(body.runs.map((r) => r.flowId)).toEqual(['a', 'b']);
  });

  it('404s when no flows match', async () => {
    const db = mockD1(ownerStmt(), mockStmt({ all: { results: [] } }));
    const res = await app.request(
      req('/v1/apps/chess-academy/qa/runs', { method: 'POST', body: JSON.stringify({ flowId: 'nope' }) }),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(404);
  });

  it('report updates the run and 404s for unknown runs', async () => {
    const db = mockD1(ownerStmt(), mockStmt({ run: { meta: { changes: 1 } } }));
    const ok = await app.request(
      req('/v1/apps/chess-academy/qa/runs/r1/report', {
        method: 'POST',
        body: JSON.stringify({ status: 'passed', stepsTotal: 3, stepsPassed: 3 }),
      }),
      undefined, makeEnv(db) as never,
    );
    expect(ok.status).toBe(200);

    const db2 = mockD1(ownerStmt(), mockStmt({ run: { meta: { changes: 0 } } }));
    const missing = await app.request(
      req('/v1/apps/chess-academy/qa/runs/rX/report', { method: 'POST', body: JSON.stringify({ status: 'failed' }) }),
      undefined, makeEnv(db2) as never,
    );
    expect(missing.status).toBe(404);
  });
});

describe('playwright transpile endpoint', () => {
  it('returns a spec for an existing flow', async () => {
    const db = mockD1(ownerStmt(), mockStmt({ first: { spec: JSON.stringify(validFlow) } }));
    const res = await app.request(
      req('/v1/apps/chess-academy/qa/flows/sign-in/playwright'),
      undefined, makeEnv(db) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("@playwright/test");
  });
});
