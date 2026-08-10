/**
 * App log retention (ADR-008 §2).
 *
 * `app_logs` had no retention and nothing that deleted from it — fine while the
 * table was unused, a growth problem the moment automatic SDK capture is on,
 * because `pas` is a single D1 shared by every app.
 *
 * Follows the existing recurring-job convention (routes/payout-cron.ts): an
 * internal endpoint guarded by `X-Internal-Token`, driven by a scheduled GitHub
 * Actions workflow, rather than a Worker cron trigger. The backend has no
 * `[triggers]` block and adding one would mean restructuring the default export,
 * which service-binding callers and every route test depend on.
 *
 * Trade-off, stated so it isn't discovered later: pruning now depends on an
 * external scheduler. If the workflow silently stops, the table grows unnoticed —
 * so the response reports what remains and the workflow surfaces it.
 */

import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import { HttpError } from '../lib/auth.js';
import type { Env } from '../types.js';

export const logsPruneRoutes = new Hono<{ Bindings: Env }>();

/** Detail rows older than this are deleted. The metrics tier (Analytics Engine)
 *  keeps 90 days, so trends outlive the rows they came from. */
export const RETENTION_DAYS = 30;
/** Usage counters are tiny but unbounded; keep a little history for the console. */
export const USAGE_RETENTION_DAYS = 90;
/** Bound each run so one call cannot exceed D1 statement limits on a large table. */
export const PRUNE_BATCH_LIMIT = 10_000;

export function cutoffMs(nowMs: number, days: number): number {
  return nowMs - days * 24 * 60 * 60 * 1000;
}

logsPruneRoutes.post('/internal/logs/prune', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    throw new HttpError('forbidden', 403);
  }

  const now = Date.now();
  // Prune on `ingested_at` (server clock), never `ts` (client clock): a forged
  // far-future `ts` would otherwise make a row immortal.
  const cutoff = cutoffMs(now, RETENTION_DAYS);

  const deleted = await c.env.DB.prepare(
    `DELETE FROM app_logs WHERE id IN (
       SELECT id FROM app_logs WHERE ingested_at < ? ORDER BY ingested_at ASC LIMIT ?
     )`,
  )
    .bind(cutoff, PRUNE_BATCH_LIMIT)
    .run();

  const usageCutoffDay = new Date(cutoffMs(now, USAGE_RETENTION_DAYS)).toISOString().slice(0, 10);
  const usageDeleted = await c.env.DB.prepare('DELETE FROM app_log_usage WHERE day < ?')
    .bind(usageCutoffDay)
    .run();

  const remaining = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM app_logs WHERE ingested_at < ?',
  )
    .bind(cutoff)
    .first<{ n: number }>();

  const overdue = remaining?.n ?? 0;
  return c.json({
    ok: true,
    retentionDays: RETENTION_DAYS,
    deleted: deleted.meta?.changes ?? 0,
    usageRowsDeleted: usageDeleted.meta?.changes ?? 0,
    // >0 means one run did not catch up. The caller should run again rather than
    // wait a day, otherwise the backlog compounds silently.
    stillOverdue: overdue,
  });
});
