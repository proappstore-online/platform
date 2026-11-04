/**
 * Guarded, idempotent, audited account mutations (#534 T02/T04, design §4 "Atomic changes").
 *
 * One D1 batch is one transaction. The FIRST statement is the guard: a conditional INSERT/UPDATE that
 * carries every authority and version condition in its WHERE clause. The second records the
 * idempotency receipt only `WHERE changes() > 0`, so a guard that matched nothing leaves no receipt.
 * Every later statement (version bump, audit, outbox, side rows) is conditioned on that receipt.
 * An UPDATE that touches zero rows is not an error in D1, which is why the batch result is inspected
 * and a no-op reported as `stale`, never as success. A duplicate idempotency key violates the
 * receipt's unique index, which rolls the whole batch back.
 */

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s) as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable JSON (sorted keys) so equal payloads hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** A secret with 256 bits of entropy, base64url. */
export function newSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

export interface OperationSpec<R extends object> {
  id: string;
  actorId: string;
  accountId: string | null;
  action: string;
  key: string;
  payloadHash: string;
  /** The result stored for replays. Known before the batch runs; must hold no secret. */
  result: R;
  now: number;
}

export type OperationOutcome<R extends object> =
  | { kind: 'committed'; result: R }
  | { kind: 'replay'; result: R }
  | { kind: 'conflict' } // the key was used with a different payload
  | { kind: 'stale' } // the guard matched no row: authority or state changed
  | { kind: 'error'; code: string; message: string };

/** The marker every post-guard statement is conditioned on. */
export const OP_EXISTS = '(SELECT 1 FROM account_operations WHERE id = ?)';

async function findOperation(db: D1Database, actorId: string, action: string, key: string): Promise<{ payload_hash: string; result_json: string } | null> {
  return db.prepare('SELECT payload_hash, result_json FROM account_operations WHERE actor_id = ?1 AND action = ?2 AND idempotency_key = ?3')
    .bind(actorId, action, key).first<{ payload_hash: string; result_json: string }>();
}

function replayOf<R extends object>(row: { payload_hash: string; result_json: string }, payloadHash: string): OperationOutcome<R> {
  return row.payload_hash === payloadHash ? { kind: 'replay', result: JSON.parse(row.result_json) as R } : { kind: 'conflict' };
}

/** SQLite trigger aborts and constraint failures surface by message; map the ones callers act on. */
function classify(e: unknown): { code: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (/last_owner/.test(message)) return { code: 'last_owner', message: 'an active team always keeps at least one owner' };
  if (/account_needs_owner/.test(message)) return { code: 'account_needs_owner', message };
  if (/UNIQUE constraint failed: accounts\.slug/.test(message)) return { code: 'slug_taken', message: 'that team handle is taken' };
  if (/UNIQUE constraint failed: account_invitations/.test(message)) return { code: 'invitation_exists', message: 'a pending invitation for that recipient already exists' };
  if (/UNIQUE constraint failed: account_operations/.test(message)) return { code: 'operation_race', message };
  return { code: 'internal', message };
}

/**
 * Run `guard` + receipt + `rest` as one batch. `rest` statements must each be conditioned on
 * OP_EXISTS bound to `spec.id`. `before` runs ahead of the batch and must be idempotent (e.g. expiring
 * stale pending invitations); it is not part of the claim.
 */
export async function commitOperation<R extends object>(
  db: D1Database, spec: OperationSpec<R>, guard: D1PreparedStatement, rest: D1PreparedStatement[], before: D1PreparedStatement[] = [],
): Promise<OperationOutcome<R>> {
  const prior = await findOperation(db, spec.actorId, spec.action, spec.key);
  if (prior) return replayOf<R>(prior, spec.payloadHash);
  if (before.length) await db.batch(before);
  const receipt = db.prepare(
    `INSERT INTO account_operations (id, actor_id, account_id, action, idempotency_key, payload_hash, result_json, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE changes() > 0`,
  ).bind(spec.id, spec.actorId, spec.accountId, spec.action, spec.key, spec.payloadHash, JSON.stringify(spec.result), spec.now);
  // A concurrent request carrying the same key may commit between the check above and this batch. The
  // loser then fails at ITS guard (a unique handle, a claim that matches nothing) before it ever reaches
  // the receipt, so the receipt for this key is the truth: look it up before classifying any failure.
  const settled = async (): Promise<OperationOutcome<R> | null> => {
    const winner = await findOperation(db, spec.actorId, spec.action, spec.key);
    return winner ? replayOf<R>(winner, spec.payloadHash) : null;
  };
  try {
    const results = await db.batch([guard, receipt, ...rest]);
    if (results[1]?.meta.changes === 1) return { kind: 'committed', result: spec.result };
    return (await settled()) ?? { kind: 'stale' };
  } catch (e) {
    return (await settled()) ?? { kind: 'error', ...classify(e) };
  }
}

/** Audit row conditioned on the receipt. `details` must already be redacted (ids, roles, versions). */
export function auditStatement(db: D1Database, spec: { opId: string; accountId: string | null; appId?: string | null; actorId: string; credential: string; action: string; targetType?: string | undefined; targetId?: string | undefined; authzVersionSql?: string; details?: Record<string, unknown>; requestId?: string | null; now: number }): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO account_audit_events (id, account_id, app_id, actor_id, credential, action, target_type, target_id, authz_version, details, request_id, operation_id, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${spec.authzVersionSql ?? 'NULL'}, ?9, ?10, ?11, ?12 WHERE EXISTS ${OP_EXISTS.replace('?', '?11')}`,
  ).bind(newId('aud'), spec.accountId, spec.appId ?? null, spec.actorId, spec.credential, spec.action, spec.targetType ?? null, spec.targetId ?? null,
    JSON.stringify(spec.details ?? {}), spec.requestId ?? null, spec.opId, spec.now);
}

/** Outbox effect conditioned on the receipt; (operation, effect) is unique so a retry cannot duplicate it. */
export function outboxStatement(db: D1Database, spec: { opId: string; effect: string; accountId: string | null; payload?: Record<string, unknown>; state: 'held' | 'pending'; now: number }): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO account_outbox (id, operation_id, effect, account_id, payload_json, state, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7 WHERE EXISTS ${OP_EXISTS.replace('?', '?2')}`,
  ).bind(newId('obx'), spec.opId, spec.effect, spec.accountId, JSON.stringify(spec.payload ?? {}), spec.state, spec.now);
}
