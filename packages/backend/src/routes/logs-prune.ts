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

/**
 * Append-only rate-limit ledgers (#223): one row per request, only ever read
 * inside a short window, never deleted before. Each lists its time column's
 * unit — a unit mix-up would delete live window rows and bypass the limit.
 */
export const LEDGER_RETENTION_DAYS = 2; // > every window read: 1 h maps, UTC day SMS, 60 s push
export const RATE_LIMIT_LEDGERS = [
  { table: 'maps_usage', column: 'ts', unit: 's' },
  { table: 'sms_usage', column: 'sent_at', unit: 'ms' },
  { table: 'notification_log', column: 'sent_at', unit: 's' },
] as const;

/**
 * Webhook delivery log (#27): one row per hook per event, holding the full
 * payload (a `storage.uploaded` row carries the uploader's user id and key).
 * Nothing reads it back; keep a week for debugging a delivery, and drop rows
 * whose webhook was deleted. `created_at` is in seconds.
 */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;
const WEBHOOK_DELIVERY_PRUNES = [
  {
    key: 'webhook_deliveries',
    where: 'created_at < ?',
    binds: (nowMs: number) => [Math.floor(cutoffMs(nowMs, WEBHOOK_DELIVERY_RETENTION_DAYS) / 1000)],
  },
  {
    key: 'webhook_deliveries_orphaned',
    where: 'NOT EXISTS (SELECT 1 FROM app_webhooks w WHERE w.id = webhook_deliveries.webhook_id)',
    binds: () => [],
  },
] as const;

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

  // Batch-bounded per table, in rowid (AUTOINCREMENT = insertion) order, so the
  // expired rows are found first without an index on the time column. One
  // ledger failing never blocks app-log retention or the others.
  const ledgerCutoffMs = cutoffMs(now, LEDGER_RETENTION_DAYS);
  const ledgerRowsDeleted: Record<string, number> = {};
  const ledgerErrors: Record<string, string> = {};
  for (const { table, column, unit } of RATE_LIMIT_LEDGERS) {
    const cutoff = unit === 's' ? Math.floor(ledgerCutoffMs / 1000) : ledgerCutoffMs;
    try {
      const res = await c.env.DB.prepare(
        `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} < ? LIMIT ?)`,
      ).bind(cutoff, PRUNE_BATCH_LIMIT).run();
      ledgerRowsDeleted[table] = res.meta?.changes ?? 0;
    } catch (err) {
      ledgerErrors[table] = err instanceof Error ? err.message.slice(0, 200) : 'prune failed';
      console.error(`[logs-prune] ledger prune failed table=${table}`, ledgerErrors[table]);
    }
  }
  // Same batching and isolation; reported alongside the ledgers so the prune
  // workflow's existing error and backlog checks cover it.
  for (const { key, where, binds } of WEBHOOK_DELIVERY_PRUNES) {
    try {
      const res = await c.env.DB.prepare(
        `DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE ${where} LIMIT ?)`,
      ).bind(...binds(now), PRUNE_BATCH_LIMIT).run();
      ledgerRowsDeleted[key] = res.meta?.changes ?? 0;
    } catch (err) {
      ledgerErrors[key] = err instanceof Error ? err.message.slice(0, 200) : 'prune failed';
      console.error(`[logs-prune] webhook delivery prune failed key=${key}`, ledgerErrors[key]);
    }
  }

  return c.json({
    ok: true,
    retentionDays: RETENTION_DAYS,
    deleted: deleted.meta?.changes ?? 0,
    usageRowsDeleted: usageDeleted.meta?.changes ?? 0,
    // >0 means one run did not catch up. The caller should run again rather than
    // wait a day, otherwise the backlog compounds silently.
    stillOverdue: overdue,
    ledgerRetentionDays: LEDGER_RETENTION_DAYS,
    webhookDeliveryRetentionDays: WEBHOOK_DELIVERY_RETENTION_DAYS,
    ledgerRowsDeleted,
    // A full batch may have left expired rows behind: the caller runs again.
    ledgerBacklog: Object.values(ledgerRowsDeleted).some((n) => n >= PRUNE_BATCH_LIMIT),
    ledgerErrors,
  });
});
