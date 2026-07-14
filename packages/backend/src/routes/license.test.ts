import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

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
    const validLicense = {
      key: 'license-key-abc',
      app_id: 'myapp',
      user_id: 'gh:1',
      issued_at: 1000,
      expires_at: Date.now() + 86400000, // 24h from now
      revoked: 0,
    };
    const licenseStmt = mockStmt({ first: validLicense });
    const db = mockD1(licenseStmt);
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
    const perpetualLicense = {
      key: 'perpetual-key',
      app_id: 'myapp',
      user_id: 'gh:1',
      issued_at: 1000,
      expires_at: null,
      revoked: 0,
    };
    const licenseStmt = mockStmt({ first: perpetualLicense });
    const db = mockD1(licenseStmt);
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
    const validLicense = {
      key: 'real-key',
      app_id: 'myapp',
      user_id: 'gh:1',
      issued_at: 1000,
      expires_at: Date.now() + 86400000,
      revoked: 0,
    };
    const licenseStmt = mockStmt({ first: validLicense });
    const db = mockD1(licenseStmt);
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
    const perpetualLicense = {
      key: 'perm-key',
      app_id: 'myapp',
      user_id: 'gh:1',
      issued_at: 1000,
      expires_at: null,
      revoked: 0,
    };
    const licenseStmt = mockStmt({ first: perpetualLicense });
    const db = mockD1(licenseStmt);
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
