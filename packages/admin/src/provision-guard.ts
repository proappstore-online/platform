/**
 * Pre-flight guards for the self-service publish path (#83).
 *
 * `/api/publish-app` mints real, costly, externally-visible resources: an org
 * repo under `proappstore-online`, a host route, CF Pages/DNS, a registry
 * commit. It is reachable by ANY signed-in GitHub account — that is the intended
 * self-service model — so the guards here are what stand between it and
 * squatting or resource exhaustion.
 *
 * Two checks, in this order:
 *   1. Ownership — is this appId already someone else's?
 *   2. Rate limit — is this caller going too fast?
 *
 * Ownership first: refusing a squatting attempt should not consume the
 * squatter's rate budget, and more importantly a legitimate owner re-publishing
 * should get a clear "not yours" rather than an opaque 429.
 */

import {
  checkProvisionQuota,
  d1ProvisionAttemptStore,
  type ProvisionQuotaResult,
} from "@proappstore/build-core";

/** Minimal D1 surface used here — keeps this testable without a real database. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  retryAfterSeconds?: number | undefined;
  /** Resolved platform user id (`gh:<id>`) when the login is known to us. */
  userId?: string | undefined;
}

interface OwnerRow {
  creator_id: string;
  creator_login: string | null;
}

/**
 * Resolve the session login to a platform user id, so the rate-limit budget is
 * shared with `/v1/provision` (which keys on `gh:<id>`). An unknown login still
 * gets a budget, just its own — better than no limit at all.
 */
async function resolveUserId(db: D1Like, login: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE LOWER(login) = LOWER(?) LIMIT 1")
    .bind(login)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Is `appId` already claimed by someone other than `login`?
 *
 * NOTE ON IDENTITY: `apps.creator_id` is `gh:<numeric github id>` (see
 * routes/auth.ts), while an admin session's subject is the GitHub *login*.
 * Comparing them directly — or building `"gh:" + login` — never matches, and
 * would 403 the legitimate owner on every re-publish. The `users` table holds
 * both, so the comparison goes through it.
 */
async function checkOwnership(
  db: D1Like,
  appId: string,
  login: string,
): Promise<GuardResult> {
  const row = await db
    .prepare(
      `SELECT a.creator_id, u.login AS creator_login
         FROM apps a
         LEFT JOIN users u ON u.id = a.creator_id
        WHERE a.id = ?`,
    )
    .bind(appId)
    .first<OwnerRow>();

  // No row — an unclaimed id. First publish proceeds; this is a "not yours"
  // check, not a "must already exist" one.
  if (!row) return { ok: true };

  if (row.creator_login && row.creator_login.toLowerCase() === login.toLowerCase()) {
    return { ok: true };
  }

  // A claimed app whose creator we cannot resolve to a login. Fail closed: the
  // row means somebody claimed the id, and letting an unverifiable caller
  // re-provision it is exactly the squatting this guards against. The distinct
  // message keeps it diagnosable if it ever fires on a legitimate user.
  if (!row.creator_login) {
    return {
      ok: false,
      status: 403,
      error: `appId "${appId}" is claimed by ${row.creator_id}, whose account could not be resolved — contact support`,
    };
  }

  return { ok: false, status: 403, error: "appId already claimed by another user" };
}

/**
 * Run both guards. Returns `{ ok: true }` when the request may proceed.
 */
export async function guardProvisionRequest(args: {
  db: D1Like;
  appId: string;
  login: string;
  ip?: string | undefined;
  nowMs?: number;
}): Promise<GuardResult> {
  const { db, appId, login } = args;

  const owned = await checkOwnership(db, appId, login);
  if (!owned.ok) return owned;

  const userId = await resolveUserId(db, login);

  let quota: ProvisionQuotaResult;
  try {
    quota = await checkProvisionQuota(d1ProvisionAttemptStore(db), {
      userKey: userId ?? `login:${login.toLowerCase()}`,
      ip: args.ip,
      nowMs: args.nowMs ?? Date.now(),
    });
  } catch (e) {
    // A limiter that cannot read its own table must not take publishing down.
    // Fail OPEN here deliberately: the ownership check above is the security
    // boundary; this one is an abuse ceiling, and availability wins.
    console.warn(`provision rate limit unavailable, allowing: ${(e as Error).message}`);
    return { ok: true, userId: userId ?? undefined };
  }

  if (!quota.allowed) {
    return {
      ok: false,
      status: 429,
      error: `provisioning rate limit reached (${quota.scope}) — retry later`,
      retryAfterSeconds: quota.retryAfterSeconds,
      userId: userId ?? undefined,
    };
  }

  return { ok: true, userId: userId ?? undefined };
}
