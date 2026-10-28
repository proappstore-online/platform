import type { Env } from '../types.js';
import { SUBSCRIPTION_SLACK_MS } from './entitlements.js';
import { recomputeSubject } from './entitlement-store.js';
import { mirrorDirtyApps } from './entitlement-mirror.js';

/**
 * The clock-driven half of the entitlements (#508). Stripe sends no event when a one-off term ends or a grace period runs out, so a
 * stored status would go stale. Each platform tick finds the entitlements the clock can have changed, recomputes them with the
 * current time (the same pure function the events use, so no rule is written twice), and pushes whatever is dirty to the apps.
 *
 * Due means: a one-off or non-renewing term at its period_end; a renewing subscription once its slack for Stripe's own event has
 * passed; a grace period at its end. A row that is not due cannot change by the clock alone, so it is not touched.
 */

/** Rows recomputed per tick; the rest are picked up by the next. */
const SWEEP_LIMIT = 500;

export interface SweepReport {
  due: number;
  changed: number;
  mirroredApps: number;
  mirroredRows: number;
}

export async function sweepEntitlements(env: Pick<Env, 'DB' | 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>, now: number = Date.now()): Promise<SweepReport> {
  const { results } = await env.DB.prepare(
    `SELECT app_id, product_key, subject FROM app_entitlements
      WHERE (status = 'active' AND period_end IS NOT NULL AND ((renews = 0 AND period_end <= ?1) OR (renews = 1 AND period_end + ?2 <= ?1)))
         OR (status = 'grace' AND grace_until IS NOT NULL AND grace_until <= ?1)
      ORDER BY period_end LIMIT ${SWEEP_LIMIT}`,
  ).bind(now, SUBSCRIPTION_SLACK_MS).all<{ app_id: string; product_key: string; subject: string }>();

  const due = results ?? [];
  let changed = 0;
  for (const row of due) {
    if (await recomputeSubject(env.DB, row.app_id, row.product_key, row.subject, now)) changed++;
  }
  const mirrored = await mirrorDirtyApps(env);
  return { due: due.length, changed, mirroredApps: mirrored.apps, mirroredRows: mirrored.rows };
}
