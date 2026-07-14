import { vi } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import type { NewSession } from '@proappstore/build-core';

/** Signing key used by all backend tests. Must match SESSION_SIGNING_KEY in test env. */
export const TEST_SK = 'test-signing-key';

/**
 * A mock D1 prepared statement. Every backend route test used a byte-identical
 * copy of this; consolidated here. `first`/`all`/`run` default to the empty
 * shapes real D1 returns.
 */
export function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0 } }),
  };
}

/**
 * A mock D1 database. Each positional stmt answers one `prepare()` call in order;
 * any further `prepare()` returns a fresh empty stmt.
 */
export function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

/**
 * Standard backend test env. The superset of bindings the routes read; tests
 * needing extra/other bindings (TWILIO_*, RESEND_API_KEY, AI, ROOM, ADMIN, …)
 * pass them via `overrides`, which win over these defaults.
 */
export function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    ...overrides,
  };
}

/** Mint a valid PAS session token for tests. */
export async function testToken(
  uid: string,
  opts?: { roles?: string[]; login?: string; appRoles?: Record<string, string[]> },
): Promise<string> {
  const claims: NewSession = {
    uid,
    login: opts?.login ?? 'testuser',
    roles: opts?.roles ?? ['user'],
    ...(opts?.appRoles ? { appRoles: opts.appRoles } : {}),
  };
  return mintSession(claims, TEST_SK);
}
