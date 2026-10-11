/**
 * Abuse bound on provisioning (#83).
 *
 * Publishing is deliberately self-service: any signed-in GitHub account may
 * publish, and every user is a `creator`. That is the product, not a bug — but
 * a single provision creates real, costly, externally-visible resources (an org
 * repo under `proappstore-online`, a D1 database, a Worker, DNS, a registry
 * commit), and nothing bounded how fast one caller could drive that loop.
 *
 * These limits are an ABUSE CEILING, not a product quota. Real publishing is a
 * handful a day; the numbers below are set well above legitimate use so that
 * hitting one means something is wrong, not that someone was busy.
 *
 * Three buckets, all fixed-window:
 *   - per user per hour   — the ordinary runaway-script case
 *   - per user per day    — a slow drip that would stay under the hourly cap
 *   - per IP per hour     — blunts spreading the same script over many accounts,
 *                           which the per-user buckets cannot see
 *
 * Deliberately NOT keyed on appId: squatting many DIFFERENT ids is the abuse,
 * so a per-app key would defeat the purpose.
 *
 * Each bucket is CLAIMED in one atomic upsert that opens or rolls the window,
 * increments the count and returns it, so parallel provisions each get a
 * distinct count from SQLite and at most `limit` of them pass a window (#303 S3,
 * the same pattern as the credential limiter, #323). A read-then-write would let
 * a burst all read the same count and all pass.
 *
 * The store is injected and described structurally rather than against
 * `D1Database`, so this module needs no Cloudflare types and stays unit-testable
 * without a database.
 */

export interface ProvisionAttemptRow {
  window_start: number;
  count: number;
}

export interface ProvisionAttemptStore {
  /**
   * Atomically take one slot in `key`'s window, opening it (or rolling an
   * expired one) at `nowMs`, and return the row as it is after the claim.
   */
  claim(key: string, nowMs: number, windowMs: number): Promise<ProvisionAttemptRow | null>;
  /** Give back one slot claimed in the window that started at `windowStart`; a rolled window is left alone. */
  release(key: string, windowStart: number): Promise<void>;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface ProvisionLimits {
  userPerHour: number;
  userPerDay: number;
  ipPerHour: number;
}

export const DEFAULT_PROVISION_LIMITS: ProvisionLimits = {
  userPerHour: 10,
  userPerDay: 30,
  ipPerHour: 20,
};

/** Minimal shape of the D1 surface this needs — avoids a workers-types dep. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

export function d1ProvisionAttemptStore(db: D1Like): ProvisionAttemptStore {
  return {
    // SQLite evaluates every SET expression against the old row, so both CASEs see the same window_start.
    async claim(key, nowMs, windowMs) {
      return db
        .prepare(
          `INSERT INTO provision_attempts (key, window_start, count) VALUES (?1, ?2, 1)
           ON CONFLICT(key) DO UPDATE SET
             window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
             count        = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END
           RETURNING window_start, count`,
        )
        .bind(key, nowMs, windowMs)
        .first<ProvisionAttemptRow>();
    },
    async release(key, windowStart) {
      await db
        .prepare('UPDATE provision_attempts SET count = count - 1 WHERE key = ? AND window_start = ? AND count > 0')
        .bind(key, windowStart)
        .run();
    },
  };
}

/**
 * One quota admission for a durable provisioning attempt. The receipt route
 * creates this row after it has admitted (and charged) an attempt; the actual
 * provision route atomically claims it before performing side effects.
 */
export interface ProvisionAdmissionLease {
  operationId: string;
  creatorId: string;
  appId: string;
  intentHash: string;
  attemptId: string;
  leaseExpiresAt: number;
  createdAt: number;
  claimedAt: number | null;
  /** Only admitted rows may be claimed to perform provisioning side effects. */
  status: ProvisionAdmissionStatus;
  statusUpdatedAt: number;
}

export type ProvisionAdmissionStatus = 'pending' | 'admitted' | 'denied' | 'unavailable';

interface ProvisionAdmissionRow {
  operation_id: string;
  creator_id: string;
  app_id: string;
  intent_hash: string;
  attempt_id: string;
  lease_expires_at: number;
  created_at: number;
  claimed_at: number | null;
  status: ProvisionAdmissionStatus;
  status_updated_at: number;
}

function admissionFromRow(row: ProvisionAdmissionRow): ProvisionAdmissionLease {
  return {
    operationId: row.operation_id,
    creatorId: row.creator_id,
    appId: row.app_id,
    intentHash: row.intent_hash,
    attemptId: row.attempt_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
  };
}

export interface ProvisionAdmissionStore {
  /** Atomically creates durable, non-executable evidence for an attempt. */
  stage(lease: Omit<ProvisionAdmissionLease, 'claimedAt' | 'status' | 'statusUpdatedAt'>): Promise<boolean>;
  read(operationId: string): Promise<ProvisionAdmissionLease | null>;
  /** Makes a staged admission executable only after its quota charge succeeds. */
  admit(operationId: string, nowMs: number): Promise<boolean>;
  /** Permanently fails a staged admission without erasing its evidence. */
  fail(operationId: string, status: Extract<ProvisionAdmissionStatus, 'denied' | 'unavailable'>, nowMs: number): Promise<boolean>;
  /** Atomically grants the side-effecting provision execution to one caller. */
  claim(operationId: string, nowMs: number): Promise<boolean>;
}

export function d1ProvisionAdmissionStore(db: D1Like): ProvisionAdmissionStore {
  return {
    async stage(lease) {
      const result = await db.prepare(
        `INSERT OR IGNORE INTO provision_admissions
           (operation_id, creator_id, app_id, intent_hash, attempt_id, lease_expires_at, created_at, status, status_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(
        lease.operationId,
        lease.creatorId,
        lease.appId,
        lease.intentHash,
        lease.attemptId,
        lease.leaseExpiresAt,
        lease.createdAt,
        lease.createdAt,
      ).run();
      return Number(result.meta?.changes ?? 0) > 0;
    },
    async read(operationId) {
      const row = await db.prepare(
        `SELECT operation_id, creator_id, app_id, intent_hash, attempt_id,
                lease_expires_at, created_at, claimed_at, status, status_updated_at
           FROM provision_admissions WHERE operation_id = ?`,
      ).bind(operationId).first<ProvisionAdmissionRow>();
      return row ? admissionFromRow(row) : null;
    },
    async admit(operationId, nowMs) {
      const result = await db.prepare(
        `UPDATE provision_admissions SET status = 'admitted', status_updated_at = ?
          WHERE operation_id = ? AND status = 'pending' AND lease_expires_at > ?`,
      ).bind(nowMs, operationId, nowMs).run();
      return Number(result.meta?.changes ?? 0) > 0;
    },
    async fail(operationId, status, nowMs) {
      const result = await db.prepare(
        `UPDATE provision_admissions SET status = ?, status_updated_at = ?
          WHERE operation_id = ? AND status = 'pending'`,
      ).bind(status, nowMs, operationId).run();
      return Number(result.meta?.changes ?? 0) > 0;
    },
    async claim(operationId, nowMs) {
      const result = await db.prepare(
        `UPDATE provision_admissions SET claimed_at = ?
          WHERE operation_id = ? AND status = 'admitted' AND claimed_at IS NULL AND lease_expires_at > ?`,
      ).bind(nowMs, operationId, nowMs).run();
      return Number(result.meta?.changes ?? 0) > 0;
    },
  };
}

export type ProvisionLimitScope = 'user-hour' | 'user-day' | 'ip-hour';

export interface ProvisionQuotaResult {
  allowed: boolean;
  /** Which bucket refused. Absent when allowed. */
  scope?: ProvisionLimitScope;
  /** Seconds until the refusing window rolls over — suitable for Retry-After. */
  retryAfterSeconds?: number;
}

export interface ProvisionQuotaOptions {
  /**
   * Stable identity for the caller. Prefer the platform user id (`gh:<id>`) so
   * the same human shares one budget across entry points; a login is a
   * reasonable fallback but gives that person a second budget.
   */
  userKey: string;
  /** Client IP, or undefined when the edge did not supply one. */
  ip?: string | undefined;
  nowMs: number;
  limits?: ProvisionLimits;
}

interface Bucket {
  key: string;
  limit: number;
  windowMs: number;
  scope: ProvisionLimitScope;
}

/**
 * Claim a slot in every bucket, in order. The first bucket whose claimed count
 * is over its limit refuses, and every slot this call claimed is given back, so
 * a refused provision costs no budget and a blocked caller cannot push its own
 * window forward. Between a claim and its release a concurrent call can see the
 * extra slot and be refused too: under contention the limiter errs toward no.
 */
export async function checkProvisionQuota(
  store: ProvisionAttemptStore,
  opts: ProvisionQuotaOptions,
): Promise<ProvisionQuotaResult> {
  const limits = opts.limits ?? DEFAULT_PROVISION_LIMITS;
  const now = opts.nowMs;

  const buckets: Bucket[] = [
    { key: `user:${opts.userKey}:h`, limit: limits.userPerHour, windowMs: HOUR_MS, scope: 'user-hour' },
    { key: `user:${opts.userKey}:d`, limit: limits.userPerDay, windowMs: DAY_MS, scope: 'user-day' },
  ];
  // An absent IP must not collapse every anonymous caller into one shared
  // bucket — that would let one abuser deny everyone else. Skip instead.
  if (opts.ip) {
    buckets.push({ key: `ip:${opts.ip}:h`, limit: limits.ipPerHour, windowMs: HOUR_MS, scope: 'ip-hour' });
  }

  const claimed: { key: string; windowStart: number }[] = [];

  for (const bucket of buckets) {
    const row = await store.claim(bucket.key, now, bucket.windowMs);
    if (!row) continue;
    claimed.push({ key: bucket.key, windowStart: row.window_start });
    if (row.count > bucket.limit) {
      for (const c of claimed) await store.release(c.key, c.windowStart);
      const elapsed = now - row.window_start;
      return {
        allowed: false,
        scope: bucket.scope,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowMs - elapsed) / 1000)),
      };
    }
  }

  return { allowed: true };
}
