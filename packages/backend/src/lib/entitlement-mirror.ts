import type { Env } from '../types.js';
import { forwardToDataWorker } from '../routes/actions.js';

/**
 * Mirror the platform's entitlements into each app's own D1 as `_pas_entitlements` (#508), so the app's registered actions can SELECT and
 * JOIN them: the paywall is enforced in the same SQL as everything else, and a forged client payload grants nothing.
 *
 * The platform's `app_entitlements` is the source of truth; this is a copy pushed over the trusted data-worker path. A row is dirty while
 * `mirrored_version < version`. A push that fails leaves its rows dirty and the sweep retries, so the platform never loses a change and
 * never needs the app to be reachable at the moment an event arrives. The mirror's upsert only accepts a version at least as new as the
 * one it holds, so a late or repeated push can never overwrite newer state.
 */

export interface MirrorRow {
  product_key: string;
  subject: string;
  status: string;
  period_end: number | null;
  grace_until: number | null;
  renews: number;
  buyer_user_id: string | null;
  version: number;
  updated_at: number;
}

/** Rows pushed per app per call; the rest wait for the next sweep. */
const MIRROR_BATCH = 200;
const MIRROR_APPS_PER_SWEEP = 25;

const CREATE_MIRROR = `CREATE TABLE IF NOT EXISTS _pas_entitlements (
  product TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  period_end INTEGER,
  grace_until INTEGER,
  renews INTEGER NOT NULL DEFAULT 0,
  buyer_user_id TEXT,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (product, subject)
)`;

const UPSERT_MIRROR = `INSERT INTO _pas_entitlements (product, subject, status, period_end, grace_until, renews, buyer_user_id, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product, subject) DO UPDATE SET status = excluded.status, period_end = excluded.period_end, grace_until = excluded.grace_until,
    renews = excluded.renews, buyer_user_id = excluded.buyer_user_id, version = excluded.version, updated_at = excluded.updated_at
  WHERE excluded.version >= _pas_entitlements.version`;

/** The statements of one push: create the table if the app does not have it yet, then one guarded upsert per row. */
export function mirrorStatements(rows: MirrorRow[]): { sql: string; params?: unknown[] }[] {
  return [
    { sql: CREATE_MIRROR },
    ...rows.map((r) => ({
      sql: UPSERT_MIRROR,
      params: [r.product_key, r.subject, r.status, r.period_end, r.grace_until, r.renews, r.buyer_user_id, r.version, r.updated_at],
    })),
  ];
}

/** Push one app's dirty rows. Returns how many rows were mirrored; a failed push mirrors none and leaves them dirty. */
export async function mirrorApp(env: Pick<Env, 'DB' | 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>, appId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT product_key, subject, status, period_end, grace_until, renews, buyer_user_id, version, updated_at
       FROM app_entitlements WHERE app_id = ? AND mirrored_version < version ORDER BY version, product_key, subject LIMIT ${MIRROR_BATCH}`,
  ).bind(appId).all<MirrorRow>();
  const rows = results ?? [];
  if (rows.length === 0) return 0;

  let ok = false;
  try {
    const res = await forwardToDataWorker(env as Env, appId, 'batch', { statements: mirrorStatements(rows) }, null);
    ok = res.ok;
    if (!ok) console.warn('[billing] mirror push refused', { appId, status: res.status });
  } catch (e) {
    console.warn('[billing] mirror push failed', { appId, error: e instanceof Error ? e.message : String(e) });
  }
  if (!ok) return 0;

  // Mark exactly the version that was pushed: a row that changed while the push was in flight stays dirty.
  await env.DB.batch(rows.map((r) => env.DB.prepare(
    'UPDATE app_entitlements SET mirrored_version = ? WHERE app_id = ? AND product_key = ? AND subject = ? AND mirrored_version < ?',
  ).bind(r.version, appId, r.product_key, r.subject, r.version)));
  return rows.length;
}

/** Push every app that has dirty rows, a bounded number per call. */
export async function mirrorDirtyApps(env: Pick<Env, 'DB' | 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>): Promise<{ apps: number; rows: number }> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT app_id FROM app_entitlements WHERE mirrored_version < version LIMIT ${MIRROR_APPS_PER_SWEEP}`).all<{ app_id: string }>();
  let rows = 0;
  let apps = 0;
  for (const { app_id } of results ?? []) {
    const n = await mirrorApp(env, app_id);
    if (n > 0) { apps++; rows += n; }
  }
  return { apps, rows };
}
