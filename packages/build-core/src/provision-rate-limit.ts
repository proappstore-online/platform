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
 * The store is injected and described structurally rather than against
 * `D1Database`, so this module needs no Cloudflare types and stays unit-testable
 * without a database.
 */

export interface ProvisionAttemptRow {
  window_start: number;
  count: number;
}

export interface ProvisionAttemptStore {
  read(key: string): Promise<ProvisionAttemptRow | null>;
  /** Upsert the row to exactly these values. */
  set(key: string, row: ProvisionAttemptRow): Promise<void>;
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
    async read(key) {
      return db
        .prepare('SELECT window_start, count FROM provision_attempts WHERE key = ?')
        .bind(key)
        .first<ProvisionAttemptRow>();
    },
    async set(key, row) {
      await db
        .prepare(
          `INSERT INTO provision_attempts (key, window_start, count) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET window_start = ?2, count = ?3`,
        )
        .bind(key, row.window_start, row.count)
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
 * Check every bucket, then consume. Nothing is written when the answer is no:
 * a blocked caller cannot push its own window forward, and hammering the
 * endpoint stops costing writes once it is over a limit.
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

  const observed: { bucket: Bucket; row: ProvisionAttemptRow | null; stale: boolean }[] = [];

  for (const bucket of buckets) {
    const row = await store.read(bucket.key);
    const stale = row === null || now - row.window_start >= bucket.windowMs;
    if (!stale && row !== null && row.count >= bucket.limit) {
      const elapsed = now - row.window_start;
      return {
        allowed: false,
        scope: bucket.scope,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowMs - elapsed) / 1000)),
      };
    }
    observed.push({ bucket, row, stale });
  }

  for (const { bucket, row, stale } of observed) {
    await store.set(
      bucket.key,
      stale ? { window_start: now, count: 1 } : { window_start: row!.window_start, count: row!.count + 1 },
    );
  }

  return { allowed: true };
}
