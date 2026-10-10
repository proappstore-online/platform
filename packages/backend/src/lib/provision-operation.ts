/** Durable, owner-bound, lease-protected receipts for MCP app provisioning (#358). */

export type ProvisionOperationStatus = 'pending' | 'completed' | 'failed';
export const PROVISION_OPERATION_LEASE_MS = 30 * 60 * 1_000;
export const MAX_PROVISION_OPERATION_ATTEMPTS = 5;
export const MAX_PROVISION_OPERATION_STEPS = 48;

export interface ProvisionOperationStep {
  name: string;
  status: 'ok' | 'skip' | 'fail' | 'pending';
  detail: string;
  completedAt: number;
  attemptId?: string;
}

export interface ProvisionOperation {
  receiptId: string;
  creatorId: string;
  appId: string;
  /** Server-hashed, canonical /v1/provision request payload. */
  intentHash: string;
  /** Server-hashed full MCP bootstrap plan used for retry equality. */
  bootstrapIntentHash: string;
  status: ProvisionOperationStatus;
  steps: ProvisionOperationStep[];
  result: Record<string, unknown> | null;
  attemptCount: number;
  leaseExpiresAt: number | null;
  attemptId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface OperationRow {
  receipt_id: string;
  creator_id: string;
  app_id: string;
  intent_hash: string;
  bootstrap_intent_hash: string;
  status: ProvisionOperationStatus;
  steps_json: string;
  result_json: string | null;
  attempt_count: number;
  lease_expires_at: number | null;
  attempt_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export type BeginProvisionOperationResult =
  | { kind: 'created' | 'recovered' | 'joined' | 'exhausted'; operation: ProvisionOperation }
  | { kind: 'intent_conflict' | 'legacy_unreconciled' | 'owner_conflict'; operation: ProvisionOperation };

export type UpdateProvisionOperationResult =
  | { kind: 'updated'; operation: ProvisionOperation }
  | { kind: 'stale' | 'terminal'; operation: ProvisionOperation | null };

function parseSteps(value: string): ProvisionOperationStep[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isStep) : [];
  } catch {
    return [];
  }
}

function parseResult(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isStep(value: unknown): value is ProvisionOperationStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  return typeof step.name === 'string'
    && typeof step.detail === 'string'
    && typeof step.completedAt === 'number'
    && (step.attemptId === undefined || typeof step.attemptId === 'string')
    && (step.status === 'ok' || step.status === 'skip' || step.status === 'fail' || step.status === 'pending');
}

function fromRow(row: OperationRow): ProvisionOperation {
  return {
    receiptId: row.receipt_id,
    creatorId: row.creator_id,
    appId: row.app_id,
    intentHash: row.intent_hash,
    bootstrapIntentHash: row.bootstrap_intent_hash,
    status: row.status,
    steps: parseSteps(row.steps_json),
    result: parseResult(row.result_json),
    attemptCount: row.attempt_count,
    leaseExpiresAt: row.lease_expires_at,
    attemptId: row.attempt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const SELECT_OPERATION = `SELECT receipt_id, creator_id, app_id, intent_hash, bootstrap_intent_hash, status, steps_json, result_json,
                                  attempt_count, lease_expires_at, attempt_id, created_at, updated_at, completed_at
                             FROM provision_operations`;

function newAttemptId(): string {
  return crypto.randomUUID();
}

/** Canonical JSON makes key order immaterial before the operation intent is hashed. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error('provisioning intent is too deeply nested');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('provisioning intent must be JSON data');
}

export async function hashProvisionIntent(intent: unknown): Promise<string> {
  const canonical = canonicalJson(intent);
  if (canonical.length > 16_384) throw new Error('provisioning intent is too large');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable server-side identity for one owner-bound receipt attempt. */
export function hashProvisionAdmissionOperation(args: {
  creatorId: string;
  appId: string;
  intentHash: string;
  attemptId: string;
}): Promise<string> {
  return hashProvisionIntent({
    creatorId: args.creatorId,
    appId: args.appId,
    intentHash: args.intentHash,
    attemptId: args.attemptId,
  });
}

export function operationNeedsLease(operation: ProvisionOperation | null, now = Date.now()): boolean {
  if (!operation) return true;
  if (operationIsExhausted(operation, now)) return false;
  if (operation.status === 'failed') return operation.attemptCount < MAX_PROVISION_OPERATION_ATTEMPTS;
  return operation.status === 'pending'
    && (operation.leaseExpiresAt === null || operation.leaseExpiresAt <= now)
    && operation.attemptCount < MAX_PROVISION_OPERATION_ATTEMPTS;
}

/**
 * A receipt with no bound fingerprint predates intent binding (0084). It is
 * historical evidence only: neither a caller-supplied intent nor receipt steps
 * can establish what it originally authorised.
 */
export function isLegacyProvisionOperation(operation: ProvisionOperation): boolean {
  return operation.intentHash === '' || operation.bootstrapIntentHash === '';
}

/**
 * An expired in-flight worker at the retry ceiling cannot make progress. Keep
 * the durable receipt/history for inspection, but never misreport it as an
 * active join or grant a sixth lease.
 */
export function operationIsExhausted(operation: ProvisionOperation, now = Date.now()): boolean {
  if (operation.attemptCount < MAX_PROVISION_OPERATION_ATTEMPTS) return false;
  if (operation.status === 'failed') return true;
  return operation.status === 'pending'
    && (operation.leaseExpiresAt === null || operation.leaseExpiresAt <= now);
}

/** Atomically creates, joins, or recovers a lease. */
export async function beginProvisionOperation(
  db: D1Database,
  args: { creatorId: string; appId: string; intentHash: string; bootstrapIntentHash: string; now?: number; leaseMs?: number },
): Promise<BeginProvisionOperationResult> {
  const now = args.now ?? Date.now();
  const leaseExpiresAt = now + (args.leaseMs ?? PROVISION_OPERATION_LEASE_MS);
  const receiptId = crypto.randomUUID();
  const attemptId = newAttemptId();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO provision_operations
       (receipt_id, creator_id, app_id, intent_hash, bootstrap_intent_hash, status, steps_json, attempt_count, lease_expires_at, attempt_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', '[]', 1, ?, ?, ?, ?)`,
  ).bind(receiptId, args.creatorId, args.appId, args.intentHash, args.bootstrapIntentHash, leaseExpiresAt, attemptId, now, now).run();
  if (Number(inserted.meta.changes) > 0) {
    const created = await getProvisionOperation(db, args.appId);
    if (!created) throw new Error('provision operation insert was not readable');
    return { kind: 'created', operation: created };
  }

  const existing = await getProvisionOperation(db, args.appId);
  if (!existing) throw new Error('provision operation conflict was not readable');
  if (existing.creatorId !== args.creatorId) return { kind: 'owner_conflict', operation: existing };
  if (isLegacyProvisionOperation(existing)) return { kind: 'legacy_unreconciled', operation: existing };
  if (existing.bootstrapIntentHash !== args.bootstrapIntentHash) return { kind: 'intent_conflict', operation: existing };
  if (operationIsExhausted(existing, now)) return { kind: 'exhausted', operation: existing };
  if (!operationNeedsLease(existing, now)) return { kind: existing.status === 'failed' ? 'exhausted' : 'joined', operation: existing };

  const nextAttemptId = newAttemptId();
  const recovered = await db.prepare(
    `UPDATE provision_operations
        SET status = 'pending', attempt_count = attempt_count + 1, lease_expires_at = ?, attempt_id = ?,
            updated_at = ?, completed_at = NULL
      WHERE receipt_id = ? AND creator_id = ? AND intent_hash = ? AND bootstrap_intent_hash = ? AND attempt_count < ?
        AND (status = 'failed' OR (status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`,
  ).bind(leaseExpiresAt, nextAttemptId, now, existing.receiptId, args.creatorId, args.intentHash, args.bootstrapIntentHash, MAX_PROVISION_OPERATION_ATTEMPTS, now).run();
  const current = await getProvisionOperation(db, args.appId);
  if (!current) throw new Error('provision operation recovery was not readable');
  if (Number(recovered.meta.changes) > 0) return { kind: 'recovered', operation: current };
  if (current.creatorId !== args.creatorId) return { kind: 'owner_conflict', operation: current };
  if (isLegacyProvisionOperation(current)) return { kind: 'legacy_unreconciled', operation: current };
  if (current.bootstrapIntentHash !== args.bootstrapIntentHash) return { kind: 'intent_conflict', operation: current };
  return { kind: operationIsExhausted(current, now) ? 'exhausted' : 'joined', operation: current };
}

export async function getProvisionOperation(db: D1Database, appId: string): Promise<ProvisionOperation | null> {
  const row = await db.prepare(`${SELECT_OPERATION} WHERE app_id = ?`).bind(appId).first<OperationRow>();
  return row ? fromRow(row) : null;
}

/** Append bounded evidence and mutate only the active matching attempt. */
export async function updateProvisionOperation(
  db: D1Database,
  receiptId: string,
  update: {
    attemptId: string;
    status?: Extract<ProvisionOperationStatus, 'completed' | 'failed'>;
    steps?: Omit<ProvisionOperationStep, 'completedAt' | 'attemptId'>[];
    result?: Record<string, unknown> | null;
    now?: number;
  },
): Promise<UpdateProvisionOperationResult> {
  const existingRow = await db.prepare(`${SELECT_OPERATION} WHERE receipt_id = ?`).bind(receiptId).first<OperationRow>();
  if (!existingRow) return { kind: 'stale', operation: null };
  const existing = fromRow(existingRow);
  const now = update.now ?? Date.now();
  if (existing.status !== 'pending') return { kind: 'terminal', operation: existing };
  if (existing.attemptId !== update.attemptId || existing.leaseExpiresAt === null || existing.leaseExpiresAt <= now) {
    return { kind: 'stale', operation: existing };
  }
  const steps = [
    ...existing.steps,
    ...(update.steps ?? []).map((step) => ({ ...step, completedAt: now, attemptId: update.attemptId })),
  ].slice(-MAX_PROVISION_OPERATION_STEPS);
  const status = update.status ?? 'pending';
  const result = update.result === undefined ? existing.result : update.result;
  const completedAt = status === 'pending' ? null : now;
  const leaseExpiresAt = status === 'pending' ? existing.leaseExpiresAt : null;
  const changed = await db.prepare(
    `UPDATE provision_operations
        SET status = ?, steps_json = ?, result_json = ?, updated_at = ?, completed_at = ?, lease_expires_at = ?
      WHERE receipt_id = ? AND status = 'pending' AND attempt_id = ? AND lease_expires_at > ?`,
  ).bind(status, JSON.stringify(steps), result === null ? null : JSON.stringify(result), now, completedAt, leaseExpiresAt, receiptId, update.attemptId, now).run();
  const current = await getProvisionOperation(db, existing.appId);
  if (!current) return { kind: 'stale', operation: null };
  return Number(changed.meta.changes) > 0 ? { kind: 'updated', operation: current } : { kind: 'stale', operation: current };
}
