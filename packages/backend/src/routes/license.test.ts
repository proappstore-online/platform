import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv } from '../test-helpers.js';
import { mintLicenseKey, LICENSE_KEY_BYTES } from './license.js';

const TOK = await testToken('gh:1');

/**
 * SQL-aware D1 mock. The validate route reads and writes the throttle bucket
 * before it touches `licenses`, so ordering-based mocks (mockD1(stmt1, ...))
 * silently hand the license fixture to the limiter. Routing on the SQL keeps
 * each test's intent legible and immune to future reordering.
 */
function licenseDb(opts: { license?: Record<string, unknown> | null; attempts?: { window_start: number; count: number } | null } = {}) {
  const prepare = vi.fn((sql: string) => {
    if (/license_validate_attempts/i.test(sql)) return mockStmt({ first: opts.attempts ?? null });
    if (/FROM licenses/i.test(sql)) return mockStmt({ first: opts.license ?? null });
    return mockStmt();
  });
  return { prepare } as unknown as ReturnType<typeof mockD1>;
}

/** A license row joined to an ACTIVE subscription — the only entitled shape (#86). */
function entitled(over: Record<string, unknown> = {}) {
  return {
    key: 'license-key-abc', app_id: 'myapp', user_id: 'gh:1', issued_at: 1000,
    expires_at: Date.now() + 86400000, revoked: 0, sub_status: 'active', ...over,
  };
}


describe('GET /v1/apps/:appId/license', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: 'Bearer bad' } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when no license exists for the user', async () => {
    const licenseStmt = mockStmt({ first: null });
    const db = mockD1(licenseStmt);
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when license is expired', async () => {
    const expiredLicense = {
      key: 'k1',
      app_id: 'myapp',
      user_id: 'gh:1',
      issued_at: 1000,
      expires_at: Date.now() - 1000, // in the past
      revoked: 0,
    };
    const licenseStmt = mockStmt({ first: expiredLicense });
    const db = mockD1(licenseStmt);
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
  });

  it('returns license when valid and not expired', async () => {
    const validLicense = entitled();
    const db = licenseDb({ license: validLicense });
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toBe('license-key-abc');
    expect(body.appId).toBe('myapp');
    expect(body.issuedAt).toBe(1000);
    expect(body.expiresAt).toBe(validLicense.expires_at);
  });

  it('returns license when expires_at is null (perpetual)', async () => {
    const perpetualLicense = entitled({ key: 'perpetual-key', expires_at: null });
    const db = licenseDb({ license: perpetualLicense });
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toBe('perpetual-key');
    expect(body.expiresAt).toBeNull();
  });
});

describe('POST /v1/license/validate', () => {
  it('returns {valid: false} when appId or key is missing', async () => {
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false });
  });

  it('returns {valid: false} when no matching license row', async () => {
    const licenseStmt = mockStmt({ first: null });
    const db = mockD1(licenseStmt);
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', key: 'bad-key' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false });
  });

  it('returns {valid: false} when license is expired', async () => {
    const expiredLicense = {
      key: 'k1',
      app_id: 'myapp',
      user_id: 'gh:1',
      issued_at: 1000,
      expires_at: Date.now() - 1000,
      revoked: 0,
    };
    const licenseStmt = mockStmt({ first: expiredLicense });
    const db = mockD1(licenseStmt);
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', key: 'k1' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false });
  });

  it('returns {valid: true} for a valid non-expired license — no auth required', async () => {
    // No auth header sent; fetch should not be called for auth
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('should not call fetch'));
    const validLicense = entitled({ key: 'real-key' });
    const db = licenseDb({ license: validLicense });
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', key: 'real-key' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it('returns {valid: true} for a perpetual license (expires_at null)', async () => {
    const perpetualLicense = entitled({ key: 'perm-key', expires_at: null });
    const db = licenseDb({ license: perpetualLicense });
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', key: 'perm-key' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });
});

// #86: a license is only good while its owner's subscription is active. Nothing
// revokes a key on cancel — the Stripe webhook flips subscriptions.status and
// never touches `licenses` — so the join is what ends the entitlement.
describe('license entitlement follows the subscription (#86)', () => {
  it('GET returns 403 when the owner has canceled', async () => {
    const db = licenseDb({ license: entitled({ sub_status: 'canceled' }) });
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/subscription inactive/i);
  });

  it('GET returns 403 when the owner is past_due', async () => {
    const db = licenseDb({ license: entitled({ sub_status: 'past_due' }) });
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('GET returns 403 when the owner has no subscription row at all', async () => {
    // LEFT JOIN yields sub_status = null rather than dropping the row.
    const db = licenseDb({ license: entitled({ sub_status: null }) });
    const res = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('GET distinguishes a missing license from a lapsed subscription', async () => {
    // The authenticated route may say which it is — it is the caller's own
    // license, and "resubscribe" is actionable where a bare 404 is not.
    const missing = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, licenseDb({ license: null })),
    );
    const lapsed = await app.request(
      '/v1/apps/myapp/license',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, licenseDb({ license: entitled({ sub_status: 'canceled' }) })),
    );
    expect(missing.status).toBe(404);
    expect(lapsed.status).toBe(403);
  });

  it('validate filters lapsed subscriptions in SQL, not in code', async () => {
    // The unauthenticated route must NOT distinguish "no such key" from "key
    // exists but lapsed" — that would confirm a guessed key. The join does the
    // filtering so a lapsed row never reaches the handler.
    const db = licenseDb({ license: null });
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', key: 'k1' }),
      },
      makeEnv({}, db),
    );
    expect(await res.json()).toEqual({ valid: false });

    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .find((s) => /FROM licenses/i.test(s));
    expect(sql).toMatch(/JOIN\s+subscriptions/i);
    expect(sql).toMatch(/status\s*=\s*'active'/i);
  });
});

describe('POST /v1/license/validate — throttle (#86)', () => {
  it('429s a caller already at the window limit', async () => {
    const db = licenseDb({ license: entitled(), attempts: { window_start: Date.now(), count: 10 } });
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({ appId: 'myapp', key: 'real-key' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(429);
    // 429, not {valid:false}: a throttled caller has been told nothing about the
    // key, and answering "invalid" would read as revocation to a legitimate app.
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/too many/i) });
  });

  it('does not query licenses at all once throttled', async () => {
    const db = licenseDb({ license: entitled(), attempts: { window_start: Date.now(), count: 10 } });
    await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({ appId: 'myapp', key: 'real-key' }),
      },
      makeEnv({}, db),
    );
    const touchedLicenses = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .some((s) => /FROM licenses/i.test(s));
    expect(touchedLicenses).toBe(false);
  });

  it('serves a caller whose previous window has rolled over', async () => {
    const stale = { window_start: Date.now() - 61_000, count: 999 };
    const db = licenseDb({ license: entitled({ key: 'real-key' }), attempts: stale });
    const res = await app.request(
      '/v1/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({ appId: 'myapp', key: 'real-key' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });
});

// #86: issuance. Nothing wrote to `licenses` before this; the read path's
// subscription join was a trap for whoever built it. These routes are that
// writer, gated the same way the reads are.
describe('POST /v1/apps/:appId/license — issuance (#86)', () => {
  /** SQL-routed mock: subscription status, existing license, and the INSERT. */
  function issueDb(opts: { sub?: string | null; existing?: Record<string, unknown> | null } = {}) {
    const insert = mockStmt({ run: { meta: { changes: 1 } } });
    const prepare = vi.fn((sql: string) => {
      if (/FROM subscriptions/i.test(sql)) return mockStmt({ first: opts.sub === null || opts.sub === undefined ? null : { status: opts.sub } });
      if (/INSERT INTO licenses/i.test(sql)) return insert;
      if (/FROM licenses/i.test(sql)) return mockStmt({ first: opts.existing ?? null });
      return mockStmt();
    });
    return { db: { prepare } as unknown as ReturnType<typeof mockD1>, insert, prepare };
  }
  const post = (db: ReturnType<typeof mockD1>) =>
    app.request('/v1/apps/myapp/license', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({}, db));

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/myapp/license', { method: 'POST', headers: { Authorization: 'Bearer bad' } }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('mints a 256-bit key for an active subscriber (201)', async () => {
    const { db, insert } = issueDb({ sub: 'active' });
    const res = await post(db);
    expect(res.status).toBe(201);
    const body = await res.json() as { key: string; appId: string; issuedAt: number; expiresAt: number | null };
    expect(body.appId).toBe('myapp');
    expect(body.expiresAt).toBeNull();
    expect(body.key).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, no padding
    // The stored key is the returned key, owned by the caller, for this app.
    const [key, appId, userId, issuedAt] = insert.bind.mock.calls[0];
    expect(key).toBe(body.key);
    expect(appId).toBe('myapp');
    expect(userId).toBe('gh:1');
    expect(issuedAt).toBe(body.issuedAt);
  });

  it('is idempotent: returns the existing live key (200) instead of minting another', async () => {
    const { db, insert } = issueDb({ sub: 'active', existing: { key: 'existing-key', app_id: 'myapp', issued_at: 5, expires_at: null } });
    const res = await post(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: 'existing-key', appId: 'myapp', issuedAt: 5, expiresAt: null });
    expect(insert.run).not.toHaveBeenCalled();
  });

  it('only reuses an un-revoked, un-expired key (filtered in SQL)', async () => {
    const { db, prepare } = issueDb({ sub: 'active' });
    await post(db);
    const lookup = prepare.mock.calls.map(([sql]) => sql as string).find((sql) => /FROM licenses/i.test(sql))!;
    expect(lookup).toMatch(/revoked = 0/);
    expect(lookup).toMatch(/expires_at IS NULL OR expires_at > \?/);
  });

  it.each(['canceled', 'past_due', 'incomplete'])('refuses to mint for a %s subscription (403)', async (status) => {
    const { db, insert } = issueDb({ sub: status });
    const res = await post(db);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('subscription inactive');
    expect(insert.run).not.toHaveBeenCalled();
  });

  it('refuses to mint when the user has no subscription row (403)', async () => {
    const { db, insert } = issueDb({ sub: null });
    const res = await post(db);
    expect(res.status).toBe(403);
    expect(insert.run).not.toHaveBeenCalled();
  });

  it('checks the subscription BEFORE reading or writing licenses', async () => {
    // A lapsed caller must not learn whether a key exists, and must not create one.
    const { db, prepare } = issueDb({ sub: 'canceled' });
    await post(db);
    const sqls = prepare.mock.calls.map(([sql]) => sql as string);
    expect(sqls.some((sql) => /licenses/i.test(sql))).toBe(false);
  });
});

describe('DELETE /v1/apps/:appId/license — revocation (#86)', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/myapp/license', { method: 'DELETE', headers: { Authorization: 'Bearer bad' } }, makeEnv());
    expect(res.status).toBe(401);
  });

  it("revokes only the caller's own un-revoked keys for the app and reports the count", async () => {
    const update = mockStmt({ run: { meta: { changes: 2 } } });
    const db = mockD1(update);
    const res = await app.request('/v1/apps/myapp/license', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 2 });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE licenses SET revoked = 1/);
    expect(sql).toMatch(/app_id = \? AND user_id = \? AND revoked = 0/);
    expect(update.bind).toHaveBeenCalledWith('myapp', 'gh:1');
  });

  it('reports zero when there was nothing to revoke', async () => {
    const db = mockD1(mockStmt({ run: { meta: { changes: 0 } } }));
    const res = await app.request('/v1/apps/myapp/license', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({}, db));
    expect(await res.json()).toEqual({ revoked: 0 });
  });
});

describe('mintLicenseKey (#86)', () => {
  it('encodes at least 128 bits of randomness', () => {
    expect(LICENSE_KEY_BYTES * 8).toBeGreaterThanOrEqual(128);
    // 32 bytes → 43 base64url chars, no padding, URL/header safe.
    expect(mintLicenseKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('draws from crypto.getRandomValues and never repeats', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const keys = new Set(Array.from({ length: 200 }, () => mintLicenseKey()));
    expect(keys.size).toBe(200);
    expect(spy).toHaveBeenCalledTimes(200);
    expect((spy.mock.calls[0][0] as Uint8Array).byteLength).toBe(LICENSE_KEY_BYTES);
    spy.mockRestore();
  });
});
