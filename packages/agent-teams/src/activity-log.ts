/**
 * Observability persistence for a project: the activity_log audit trail and the
 * cost_ledger summary. Pure free functions over SqlStorage — no broadcast — so
 * the SQL lives in one cohesive place apart from ProjectDO. The DO keeps thin
 * wrappers that add the live broadcast (logActivity / setActivityMeta /
 * clearActivity).
 */
import { uuid } from './store.ts';

export interface ActivityRow {
  id: string;
  ticketId: string | null;
  type: string;
  detail: string;
  createdAt: number;
  meta?: string;
}

/** Append an audit row. Returns the bits the caller needs to broadcast it. */
export function insertActivity(
  sql: SqlStorage,
  a: { type: string; detail: string; ticketId?: string | null; meta?: string },
): { id: string; createdAt: number; meta: string | null } {
  const id = uuid();
  const now = Date.now();
  const metaStr = a.meta ? a.meta.slice(0, 20000) : null; // cap; full tool output kept for audit
  sql.exec(
    'INSERT INTO activity_log (id, ticket_id, type, detail, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)',
    id, a.ticketId ?? null, a.type, a.detail.slice(0, 1000), now, metaStr,
  );
  return { id, createdAt: now, meta: metaStr };
}

/** Attach a tool call's output to its already-logged row. Returns the capped meta. */
export function updateActivityMeta(sql: SqlStorage, id: string, meta: string): string {
  const metaStr = meta.slice(0, 20000);
  sql.exec('UPDATE activity_log SET meta = ? WHERE id = ?', metaStr, id);
  return metaStr;
}

export function clearActivityLog(sql: SqlStorage): void {
  sql.exec('DELETE FROM activity_log');
}

/** Most recent audit rows, oldest-first (capped). */
export function readActivity(sql: SqlStorage): ActivityRow[] {
  const rows = sql
    .exec('SELECT id, ticket_id, type, detail, created_at, meta FROM activity_log ORDER BY created_at DESC LIMIT 500')
    .toArray() as { id: string; ticket_id: string | null; type: string; detail: string; created_at: number; meta: string | null }[];
  return rows.reverse().map((r) => ({
    id: r.id, ticketId: r.ticket_id, type: r.type, detail: r.detail, createdAt: r.created_at,
    ...(r.meta != null ? { meta: r.meta } : {}),
  }));
}

/** Monthly cost cap/spend plus per-role and top-ticket breakdowns. */
export function costSummary(sql: SqlStorage): {
  cap: number; spent: number; byRole: unknown[]; topTickets: unknown[];
} {
  const proj = sql
    .exec('SELECT cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1')
    .toArray()[0] as { cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;
  const byRole = sql
    .exec('SELECT role, SUM(cost_usd) as total, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out FROM cost_ledger GROUP BY role')
    .toArray();
  const topTickets = sql
    .exec('SELECT ticket_id, SUM(cost_usd) as total FROM cost_ledger GROUP BY ticket_id ORDER BY total DESC LIMIT 10')
    .toArray();
  return { cap: proj?.cost_cap_monthly_usd ?? 0, spent: proj?.cost_spent_monthly_usd ?? 0, byRole, topTickets };
}
