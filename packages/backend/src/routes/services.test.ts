import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]) };
}

function env(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({ AI: { run: vi.fn() }, ...overrides }, db ?? mockD1());
}

describe('GET /v1/services/developers', () => {
  it('returns 200 with empty list (no auth needed)', async () => {
    const db = mockD1(mockStmt({ all: { results: [] } }));
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const res = await app.request('/v1/services/developers', {}, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { developers: unknown[] };
    expect(body.developers).toEqual([]);
  });
});

describe('GET /v1/services/profile', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/services/profile', {}, env());
    expect(res.status).toBe(401);
  });

  it('returns exists:false when no profile exists', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request('/v1/services/profile', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean };
    expect(body.exists).toBe(false);
  });
});

describe('PUT /v1/services/profile', () => {
  it('validates rate range', async () => {
    const res = await app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptRateCents: 5 }), // below min 10
    }, env());
    expect(res.status).toBe(400);
  });

  it('validates rate upper bound', async () => {
    const res = await app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptRateCents: 10000 }), // above max 5000
    }, env());
    expect(res.status).toBe(400);
  });

  it('validates bio length', async () => {
    const res = await app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bioServices: 'x'.repeat(2001) }),
    }, env());
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/services/balance', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/services/balance', {}, env());
    expect(res.status).toBe(401);
  });

  it('returns 0 balance when no record exists', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request('/v1/services/balance', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { balanceCents: number };
    expect(body.balanceCents).toBe(0);
  });
});

describe('POST /v1/services/balance/deposit', () => {
  it('rejects amount below minimum', async () => {
    const res = await app.request('/v1/services/balance/deposit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 500, successUrl: 'https://proappstore.online/app', cancelUrl: 'https://proappstore.online/app' }),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects amount above maximum', async () => {
    const res = await app.request('/v1/services/balance/deposit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 200000, successUrl: 'https://proappstore.online/app', cancelUrl: 'https://proappstore.online/app' }),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects bad redirect URLs', async () => {
    const res = await app.request('/v1/services/balance/deposit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000, successUrl: 'https://evil.com', cancelUrl: 'https://proappstore.online/app' }),
    }, env());
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/services/recompute-stats', () => {
  it('rejects without internal token', async () => {
    const res = await app.request('/v1/services/recompute-stats', {
      method: 'POST',
    }, env());
    expect(res.status).toBe(403);
  });

  it('rejects with wrong token', async () => {
    const res = await app.request('/v1/services/recompute-stats', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'wrong' },
    }, env({ INTERNAL_TOKEN: 'correct' }));
    expect(res.status).toBe(403);
  });
});

// #217 (child of #27): the public developer bio is moderated when it changes.
describe('PUT /v1/services/profile — Workers AI moderation of bioServices (#217)', () => {
  // Answers by SQL: the stored bio, the post-write read-back, and records the write.
  const put = (body: Record<string, unknown>, ai: unknown, storedBio: string | null = 'Builds booking apps.') => {
    const writes: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => sql.includes('SELECT bio_services') ? { bio_services: storedBio }
            : sql.includes('SELECT * FROM dev_profiles') ? { creator_id: 'gh:1', prompt_rate_cents: 100, bio_services: storedBio, available: 1, avg_rating: null, rating_count: 0, created_at: 1, updated_at: 1 }
            : null,
          run: async () => { if (sql.includes('INSERT INTO dev_profiles')) writes.push(args); return { meta: { changes: 1 } }; },
          all: async () => ({ results: [] }),
        }),
      })),
      batch: vi.fn(),
    } as unknown as ReturnType<typeof mockD1>;
    return { db, writes, res: app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env({ AI: ai }, db)) };
  };
  const wrote = (db: ReturnType<typeof mockD1>) => db.prepare.mock.calls.some((c) => String(c[0]).includes('INSERT INTO dev_profiles'));

  it('an unsafe new bio → 422 with categories, and the profile is not written', async () => {
    const { db, res } = put({ bioServices: 'hateful bio', promptRateCents: 100 }, { run: vi.fn(async () => ({ response: 'unsafe\nS10' })) });
    expect((await res).status).toBe(422);
    expect(await (await res).json()).toEqual({ error: 'bio rejected by content moderation', categories: ['S10'] });
    expect(wrote(db)).toBe(false);
  });

  it('fails closed: a model error or missing binding → 503 + Retry-After 5, not written', async () => {
    const failing = put({ bioServices: 'New bio' }, { run: vi.fn(async () => { throw new Error('down'); }) });
    const r = await failing.res;
    expect(r.status).toBe(503);
    expect(r.headers.get('Retry-After')).toBe('5');
    expect(wrote(failing.db)).toBe(false);
    const missing = put({ bioServices: 'New bio' }, undefined);
    expect((await missing.res).status).toBe(503);
    expect(wrote(missing.db)).toBe(false);
  });

  it('a safe new bio is moderated once and written', async () => {
    const ai = { run: vi.fn(async () => ({ response: 'safe' })) };
    const { db, res } = put({ bioServices: 'I build chess apps.' }, ai);
    expect((await res).status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(wrote(db)).toBe(true);
  });

  it('an unchanged bio, a cleared bio, or a rate/availability-only update never calls the model', async () => {
    const ai = { run: vi.fn() };
    expect((await put({ bioServices: 'Builds booking apps.' }, ai).res).status).toBe(200);
    expect((await put({ bioServices: '' }, ai).res).status).toBe(200);
    expect((await put({ promptRateCents: 250, available: false }, ai).res).status).toBe(200);
    expect(ai.run).not.toHaveBeenCalled();
  });
});

// #218: bio moderation is bounded per user too.
describe('PUT /v1/services/profile — moderation call bound (#218)', () => {
  it('over the bound → 429 before any model call, profile not written', async () => {
    const rate = { limit: vi.fn(async () => ({ success: false })) };
    const ai = { run: vi.fn() };
    const db = mockD1(mockStmt({ first: { bio_services: 'old bio' } }));
    const res = await app.request('/v1/services/profile', {
      method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bioServices: 'new bio' }),
    }, env({ AI: ai, MODERATION_RATE_LIMIT: rate }, db));
    expect(res.status).toBe(429);
    expect(rate.limit).toHaveBeenCalledWith({ key: 'mod:gh:1' });
    expect(ai.run).not.toHaveBeenCalled();
    expect(db.prepare.mock.calls.some((c) => String(c[0]).includes('INSERT INTO dev_profiles'))).toBe(false);
  });
});
