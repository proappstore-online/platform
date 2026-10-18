import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { aboutOrigin, ENQUIRY_HONEYPOT, ENQUIRY_IP_LIMIT } from './enquiries.js';

// #412 on a scripted D1 (real-D1 coverage is in runtime-tests/test/backend/enquiries.test.ts).

const ORIGIN = aboutOrigin('shop');
const ID = '0b6f4a8e-3c1d-4f2a-9e7b-5d6c7b8a9f01';
const good = { name: 'Ada', email: 'ada@example.com', message: 'Hello' };

/** A D1 that answers by SQL: the app exists (owned by gh:1), the rate-limit counts are `counts`. */
function db(opts: { app?: boolean; counts?: { from_ip: number; today: number }; row?: unknown; changes?: number } = {}) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const prepare = vi.fn((sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => { args = a; return stmt; },
      first: async () => {
        if (sql.includes('FROM apps')) return opts.app === false ? null : sql.includes('creator_id') ? { creator_id: 'gh:1' } : { 1: 1 };
        if (sql.includes('AS from_ip')) return opts.counts ?? { from_ip: 0, today: 0 };
        if (sql.includes('AS new_count')) return { new_count: 1, total: 2 };
        if (sql.includes('FROM app_enquiries')) return opts.row ?? null;
        return null;
      },
      all: async () => ({ results: sql.includes('FROM app_enquiries') ? [{ id: ID, ...good, status: 'new' }] : [] }),
      run: async () => { runs.push({ sql, args }); return { meta: { changes: opts.changes ?? 1 } }; },
    };
    return stmt;
  });
  return { env: makeEnv({ DB: { prepare, batch: vi.fn() } }), runs };
}

const post = (body: BodyInit, type: string, origin: string | null = ORIGIN) => ({
  method: 'POST', body,
  headers: { 'Content-Type': type, 'CF-Connecting-IP': '203.0.113.7', ...(origin ? { Origin: origin } : {}) },
});
const form = (fields: Record<string, string>) => post(new URLSearchParams(fields).toString(), 'application/x-www-form-urlencoded');
const asJson = (body: unknown, origin?: string | null) => post(JSON.stringify(body), 'application/json', origin);

describe('POST /v1/apps/:appId/enquiries (#412)', () => {
  it('stores a valid JSON enquiry with a hashed IP, and answers a form with a 303 back to the site', async () => {
    const { env, runs } = db();
    const res = await app.request('/v1/apps/shop/enquiries', asJson(good), env);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, id: expect.any(String) });
    const insert = runs.find((r) => r.sql.startsWith('INSERT INTO app_enquiries'))!;
    expect(insert.args.slice(1, 5)).toEqual(['shop', 'Ada', 'ada@example.com', 'Hello']);
    expect(insert.args[5]).toMatch(/^[0-9a-f]{64}$/); // never the raw IP

    const f = await app.request('/v1/apps/shop/enquiries', form(good), db().env);
    expect(f.status).toBe(303);
    expect(f.headers.get('Location')).toBe(`${ORIGIN}/?enquiry=sent#enquiry-sent`);
  });

  it('refuses a foreign or missing origin (403), an unknown or invalid app (404) and an oversized body (413)', async () => {
    expect((await app.request('/v1/apps/shop/enquiries', asJson(good, 'https://evil.example'), db().env)).status).toBe(403);
    expect((await app.request('/v1/apps/shop/enquiries', asJson(good, null), db().env)).status).toBe(403);
    expect((await app.request('/v1/apps/shop/enquiries', asJson(good), db({ app: false }).env)).status).toBe(404);
    expect((await app.request('/v1/apps/Bad_Id/enquiries', asJson(good), db().env)).status).toBe(404);
    const big = { ...asJson(good), headers: { ...asJson(good).headers, 'Content-Length': String(20 * 1024) } };
    expect((await app.request('/v1/apps/shop/enquiries', big, db().env)).status).toBe(413);
  });

  it('validates fields and the body; a form gets the outcome in the redirect', async () => {
    for (const bad of [{ ...good, email: 'x' }, { ...good, name: '' }, { ...good, message: 'm'.repeat(5001) }, { ...good, name: 7 }]) {
      const { env, runs } = db();
      const res = await app.request('/v1/apps/shop/enquiries', asJson(bad), env);
      expect(res.status).toBe(400);
      expect(runs).toEqual([]);
    }
    expect((await app.request('/v1/apps/shop/enquiries', post('{not json', 'application/json'), db().env)).status).toBe(400);
    expect((await app.request('/v1/apps/shop/enquiries', post('null', 'application/json'), db().env)).status).toBe(400);
    const f = await app.request('/v1/apps/shop/enquiries', form({ ...good, email: 'nope' }), db().env);
    expect(f.headers.get('Location')).toBe(`${ORIGIN}/?enquiry=invalid#enquiry-invalid`);
  });

  it('a filled honeypot looks like success and writes nothing', async () => {
    const { env, runs } = db();
    const res = await app.request('/v1/apps/shop/enquiries', asJson({ ...good, [ENQUIRY_HONEYPOT]: 'x' }), env);
    expect(res.status).toBe(201);
    expect(runs).toEqual([]);
  });

  it('429 with Retry-After at the per-IP or per-app limit, writing nothing', async () => {
    for (const counts of [{ from_ip: ENQUIRY_IP_LIMIT, today: 1 }, { from_ip: 0, today: 10_000 }]) {
      const { env, runs } = db({ counts });
      const res = await app.request('/v1/apps/shop/enquiries', asJson(good), env);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('3600');
      expect(runs).toEqual([]);
    }
    const f = await app.request('/v1/apps/shop/enquiries', form(good), db({ counts: { from_ip: 99, today: 99 } }).env);
    expect(f.headers.get('Location')).toBe(`${ORIGIN}/?enquiry=rate-limited#enquiry-rate-limited`);
  });
});

describe('owner enquiry API (#412)', () => {
  const owner = async () => ({ Authorization: `Bearer ${await testToken('gh:1')}` });

  it('lists with counts, filters by status, reads one and marks it handled', async () => {
    const list = await app.request('/v1/apps/shop/enquiries?status=new&limit=500', { headers: await owner() }, db().env);
    expect(await list.json()).toEqual({ enquiries: [{ id: ID, ...good, status: 'new' }], counts: { new: 1, total: 2 } });
    expect((await app.request('/v1/apps/shop/enquiries?status=spam', { headers: await owner() }, db().env)).status).toBe(400);
    expect((await app.request('/v1/apps/shop/enquiries?before=abc', { headers: await owner() }, db().env)).status).toBe(400);

    const one = await app.request(`/v1/apps/shop/enquiries/${ID}`, { headers: await owner() }, db({ row: { id: ID } }).env);
    expect(await one.json()).toEqual({ id: ID });
    expect((await app.request(`/v1/apps/shop/enquiries/${ID}`, { headers: await owner() }, db().env)).status).toBe(404);
    expect((await app.request('/v1/apps/shop/enquiries/not-an-id', { headers: await owner() }, db().env)).status).toBe(404);

    const patch = (body: unknown, id = ID, changes = 1) =>
      owner().then((h) => app.request(`/v1/apps/shop/enquiries/${id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, db({ changes }).env));
    expect(await (await patch({ status: 'handled' })).json()).toEqual({ id: ID, status: 'handled' });
    expect((await patch({ status: 'new' })).status).toBe(200);
    expect((await patch({ status: 'gone' })).status).toBe(400);
    expect((await patch({ status: 'handled' }, ID, 0)).status).toBe(404);
    expect((await patch({ status: 'handled' }, 'not-an-id')).status).toBe(404);
  });

  it('another signed-in user is refused, and signed out is 401', async () => {
    const other = { Authorization: `Bearer ${await testToken('gh:2')}` };
    expect((await app.request('/v1/apps/shop/enquiries', { headers: other }, db().env)).status).toBe(403);
    expect((await app.request('/v1/apps/shop/enquiries', {}, db().env)).status).toBe(401);
  });
});
