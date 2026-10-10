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
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

export interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  retryAfterSeconds?: number | undefined;
  /** Immutable authenticated platform user id (`gh:<id>`). */
  userId?: string | undefined;
}

interface OwnerRow {
  creator_id: string;
}

/**
 * Is `appId` already claimed by someone other than the immutable session uid?
 */
async function checkOwnership(
  db: D1Like,
  appId: string,
  userId: string,
): Promise<GuardResult> {
  const row = await db
    .prepare(
      "SELECT creator_id FROM apps WHERE id = ?",
    )
    .bind(appId)
    .first<OwnerRow>();

  // No row — an unclaimed id. First publish proceeds; this is a "not yours"
  // check, not a "must already exist" one.
  if (!row) return { ok: true };

  if (row.creator_id === userId) {
    return { ok: true };
  }
  return { ok: false, status: 403, error: "appId already claimed by another user" };
}

/**
 * Run both guards. Returns `{ ok: true }` when the request may proceed.
 */
export async function guardProvisionRequest(args: {
  db: D1Like;
  appId: string;
  /** Immutable UID from a verified GitHub session, never a display/login claim. */
  userId: string;
  ip?: string | undefined;
  nowMs?: number;
}): Promise<GuardResult> {
  const { db, appId, userId } = args;

  const owned = await checkOwnership(db, appId, userId);
  if (!owned.ok) return owned;

  let quota: ProvisionQuotaResult;
  try {
    quota = await checkProvisionQuota(d1ProvisionAttemptStore(db), {
      userKey: userId,
      ip: args.ip,
      nowMs: args.nowMs ?? Date.now(),
    });
  } catch (e) {
    // A limiter that cannot read its own table must not take publishing down.
    // Fail OPEN here deliberately: the ownership check above is the security
    // boundary; this one is an abuse ceiling, and availability wins.
    console.warn(`provision rate limit unavailable, allowing: ${(e as Error).message}`);
    return { ok: true, userId };
  }

  if (!quota.allowed) {
    return {
      ok: false,
      status: 429,
      error: `provisioning rate limit reached (${quota.scope}) — retry later`,
      retryAfterSeconds: quota.retryAfterSeconds,
      userId,
    };
  }

  return { ok: true, userId };
}
