import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { sealSecret } from '../lib/encryption.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    SESSION_SIGNING_KEY: TEST_SK,
    ...overrides,
  };
}

function randomKek(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

describe('GET /v1/keys/providers (public)', () => {
  it('returns the provider registry', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [{ id: 'anthropic', name: 'Anthropic', docs_url: null, key_prefix: 'sk-ant-' }] } }),
    );
    const res = await app.request('/v1/keys/providers', {}, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string }[] };
    expect(body.providers[0]!.id).toBe('anthropic');
  });
});

describe('GET /v1/keys/resolve/:provider — internal auth', () => {
  it('401s with neither internal token nor user session', async () => {
    const res = await app.request('/v1/keys/resolve/anthropic', {}, makeEnv({ INTERNAL_TOKEN: 'secret' }));
    expect(res.status).toBe(401);
  });

  it('400s when internal token is valid but X-Owner-Id is missing', async () => {
    const res = await app.request(
      '/v1/keys/resolve/anthropic',
      { headers: { 'X-Internal-Token': 'secret' } },
      makeEnv({ INTERNAL_TOKEN: 'secret' }),
    );
    expect(res.status).toBe(400);
  });

  it('503s when the vault KEK is not configured', async () => {
    const res = await app.request(
      '/v1/keys/resolve/anthropic',
      { headers: { 'X-Internal-Token': 'secret', 'X-Owner-Id': 'gh:1' } },
      makeEnv({ INTERNAL_TOKEN: 'secret' }),
    );
    expect(res.status).toBe(503);
  });

  it('returns { key: null } when the owner has no key for the provider', async () => {
    const kek = randomKek();
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request(
      '/v1/keys/resolve/anthropic',
      { headers: { 'X-Internal-Token': 'secret', 'X-Owner-Id': 'gh:1' } },
      makeEnv({ INTERNAL_TOKEN: 'secret', APP_SECRET_KEK: kek }, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: null });
  });

  it('decrypts and returns the owner key over the internal path (round-trip)', async () => {
    const kek = randomKek();
    const sealed = await sealSecret('sk-ant-secret-value', kek);
    const db = mockD1(
      mockStmt({
        first: {
          key_ciphertext: sealed.keyCiphertext,
          dek_wrapped: sealed.dekWrapped,
          iv: sealed.iv,
        },
      }),
    );
    const res = await app.request(
      '/v1/keys/resolve/anthropic',
      { headers: { 'X-Internal-Token': 'secret', 'X-Owner-Id': 'gh:1' } },
      makeEnv({ INTERNAL_TOKEN: 'secret', APP_SECRET_KEK: kek }, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: 'sk-ant-secret-value' });
  });
});

describe('PUT /v1/keys/:provider', () => {
  it('rejects a key that fails the provider prefix check', async () => {
    const db = mockD1(
      mockStmt({ first: { id: 'anthropic', key_prefix: 'sk-ant-' } }), // provider lookup
    );
    const res = await app.request(
      '/v1/keys/anthropic',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'wrong-prefix-key' }),
      },
      makeEnv({ APP_SECRET_KEK: randomKek() }, db),
    );
    expect(res.status).toBe(400);
  });
});
