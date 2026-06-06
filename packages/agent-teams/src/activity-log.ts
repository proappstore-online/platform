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
    .exec('SELECT cost_cap_monthly_usd, cost_spent_monthly_usd, cost_month FROM project LIMIT 1')
    .toArray()[0] as { cost_cap_monthly_usd: number; cost_spent_monthly_usd: number; cost_month: string } | undefined;
  // Spend is only reset on the first spend of a new month (storeMessage), so a
  // stale cost_month means "this month's spend is 0" — match getProject/autoAdvance
  // and don't report last month's total after a rollover.
  const currentMonth = new Date().toISOString().slice(0, 7);
  const spent = proj && proj.cost_month === currentMonth ? proj.cost_spent_monthly_usd : 0;
  const byRole = sql
    .exec('SELECT role, SUM(cost_usd) as total, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out FROM cost_ledger GROUP BY role')
    .toArray();
  const topTickets = sql
    .exec('SELECT ticket_id, SUM(cost_usd) as total FROM cost_ledger GROUP BY ticket_id ORDER BY total DESC LIMIT 10')
    .toArray();
  return { cap: proj?.cost_cap_monthly_usd ?? 0, spent, byRole, topTickets };
}

/** Full cost detail: per-ticket breakdown by role, plus the raw ledger entries. */
export function costDetail(sql: SqlStorage): {
  totalUsd: number;
  byRole: { role: string; total: number; tokensIn: number; tokensOut: number }[];
  byTicket: { ticketId: string; title: string; total: number; byRole: { role: string; total: number; tokensIn: number; tokensOut: number }[] }[];
  ledger: { ticketId: string; role: string; costUsd: number; tokensIn: number; tokensOut: number; model: string; createdAt: number }[];
} {
  const totalRow = sql
    .exec('SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_ledger')
    .toArray()[0] as { total: number };
  const totalUsd = totalRow.total;

  const byRole = sql
    .exec('SELECT role, SUM(cost_usd) as total, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out FROM cost_ledger GROUP BY role ORDER BY total DESC')
    .toArray() as { role: string; total: number; tokens_in: number; tokens_out: number }[];

  // Per-ticket totals joined with ticket title
  const ticketTotals = sql
    .exec(`SELECT cl.ticket_id, t.title, SUM(cl.cost_usd) as total
           FROM cost_ledger cl LEFT JOIN tickets t ON cl.ticket_id = t.id
           GROUP BY cl.ticket_id ORDER BY total DESC`)
    .toArray() as { ticket_id: string; title: string | null; total: number }[];

  // Per-ticket per-role breakdown
  const ticketRoles = sql
    .exec(`SELECT ticket_id, role, SUM(cost_usd) as total, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out
           FROM cost_ledger GROUP BY ticket_id, role`)
    .toArray() as { ticket_id: string; role: string; total: number; tokens_in: number; tokens_out: number }[];

  const rolesByTicket = new Map<string, { role: string; total: number; tokensIn: number; tokensOut: number }[]>();
  for (const r of ticketRoles) {
    const arr = rolesByTicket.get(r.ticket_id) ?? [];
    arr.push({ role: r.role, total: r.total, tokensIn: r.tokens_in, tokensOut: r.tokens_out });
    rolesByTicket.set(r.ticket_id, arr);
  }

  const byTicket = ticketTotals.map(t => ({
    ticketId: t.ticket_id,
    title: t.title ?? '(deleted)',
    total: t.total,
    byRole: rolesByTicket.get(t.ticket_id) ?? [],
  }));

  // Recent ledger entries (newest first, capped)
  const ledger = sql
    .exec('SELECT ticket_id, role, cost_usd, tokens_in, tokens_out, model, created_at FROM cost_ledger ORDER BY created_at DESC LIMIT 200')
    .toArray() as { ticket_id: string; role: string; cost_usd: number; tokens_in: number; tokens_out: number; model: string; created_at: number }[];

  return {
    totalUsd,
    byRole: byRole.map(r => ({ role: r.role, total: r.total, tokensIn: r.tokens_in, tokensOut: r.tokens_out })),
    byTicket,
    ledger: ledger.map(l => ({ ticketId: l.ticket_id, role: l.role, costUsd: l.cost_usd, tokensIn: l.tokens_in, tokensOut: l.tokens_out, model: l.model, createdAt: l.created_at })),
  };
}
