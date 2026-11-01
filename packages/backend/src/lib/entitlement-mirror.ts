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

/**
 * A table an app migration already created (chess-academy's 0061 does, so its paywall SQL works before the platform ships) is adopted,
 * never dropped or recreated: the columns it lacks are added, and its rows stay. The contract is `product`, `subject` plus these.
 * A NOT NULL column is added with a default so existing rows remain valid; `version` starts at 0, so the platform's copy of a row
 * always replaces what the app had for the same (product, subject).
 */
const ADOPT_COLUMNS: Record<string, string> = {
  status: "TEXT NOT NULL DEFAULT 'expired'",
  period_end: 'INTEGER',
  grace_until: 'INTEGER',
  renews: 'INTEGER NOT NULL DEFAULT 0',
  buyer_user_id: 'TEXT',
  version: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
};
/** The upsert's ON CONFLICT needs a key on (product, subject); an adopted table may have none. */
const ADOPT_KEY = 'CREATE UNIQUE INDEX IF NOT EXISTS _pas_entitlements_product_subject ON _pas_entitlements (product, subject)';

const UPSERT_MIRROR = `INSERT INTO _pas_entitlements (product, subject, status, period_end, grace_until, renews, buyer_user_id, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product, subject) DO UPDATE SET status = excluded.status, period_end = excluded.period_end, grace_until = excluded.grace_until,
    renews = excluded.renews, buyer_user_id = excluded.buyer_user_id, version = excluded.version, updated_at = excluded.updated_at
  WHERE excluded.version >= _pas_entitlements.version`;

/**
 * What it takes to make an existing `_pas_entitlements` hold the contract: an ADD COLUMN for each column it lacks, then the key.
 * Throws when the table has no `product` and `subject`: it is not an entitlement table, and the platform does not alter it.
 */
export function adoptionStatements(existing: readonly string[]): { sql: string }[] {
  const have = new Set(existing.map((c) => c.toLowerCase()));
  if (!have.has('product') || !have.has('subject')) {
    throw new Error('_pas_entitlements exists without the product and subject columns, so it is not an entitlement table and is left alone');
  }
  return [
    ...Object.entries(ADOPT_COLUMNS).filter(([name]) => !have.has(name)).map(([name, def]) => ({ sql: `ALTER TABLE _pas_entitlements ADD COLUMN ${name} ${def}` })),
    { sql: ADOPT_KEY },
  ];
}

/** Without a table it is created; with one it is adopted (see {@link adoptionStatements}). Shared by a row push and {@link ensureMirrorTable}. */
function mirrorDdlStatements(existing: readonly string[]): { sql: string }[] {
  return existing.length === 0 ? [{ sql: CREATE_MIRROR }] : adoptionStatements(existing);
}

/**
 * The statements of one push, then one guarded upsert per row. `existing` is the column list of the app's `_pas_entitlements` (empty when
 * it has none): without a table it is created; with one it is adopted (see {@link adoptionStatements}).
 */
export function mirrorStatements(rows: MirrorRow[], existing: readonly string[] = []): { sql: string; params?: unknown[] }[] {
  return [
    ...mirrorDdlStatements(existing),
    ...rows.map((r) => ({
      sql: UPSERT_MIRROR,
      params: [r.product_key, r.subject, r.status, r.period_end, r.grace_until, r.renews, r.buyer_user_id, r.version, r.updated_at],
    })),
  ];
}

/** The columns of the app's `_pas_entitlements`, lowercased; empty when the app has no such table. A refusal throws, so the rows stay dirty. */
async function existingColumns(env: Pick<Env, 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>, appId: string): Promise<string[]> {
  const res = await forwardToDataWorker(env as Env, appId, 'query', { sql: 'PRAGMA table_info(_pas_entitlements)' }, null);
  if (!res.ok) throw new Error(`column discovery refused (${res.status})`);
  const body = (await res.json()) as { rows?: { name?: unknown }[] };
  return (body.rows ?? []).map((r) => String(r.name ?? '').toLowerCase()).filter((n) => n !== '');
}

/**
 * Make the app's `_pas_entitlements` exist — empty, created or adopted — before anything else touches its D1 (#510). The deploy path
 * calls this ahead of the app's own migrations, so action SQL that JOINs `_pas_entitlements` from day one has something to join
 * against, instead of waiting for the first entitlement event to reach {@link mirrorApp}. Same trusted internal push as a row push;
 * idempotent, since a table already in its final shape gets only `IF NOT EXISTS` / already-present statements.
 */
export async function ensureMirrorTable(env: Pick<Env, 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>, appId: string): Promise<void> {
  const statements = mirrorDdlStatements(await existingColumns(env, appId));
  const res = await forwardToDataWorker(env as Env, appId, 'batch', { statements }, null);
  if (!res.ok) throw new Error(`ensureMirrorTable refused (${res.status})`);
}

/**
 * Push one app's dirty rows. Returns how many rows were mirrored; a failed push mirrors none and leaves them dirty.
 *
 * #519: only rows of the app's CURRENTLY ACTIVE Stripe env are ever eligible. An app with no app_billing row (every
 * app before this existed) is treated as 'live' via COALESCE, so this is a no-op change for an app that has never
 * touched test mode. A dirty row of the other env is simply never selected here — it stays dirty until the admin
 * switches back, at which point the next sweep picks it up — so a test-mode entitlement can never reach `_pas_entitlements`
 * while the app is live, and a live one can never be overwritten by a leftover test push.
 */
export async function mirrorApp(env: Pick<Env, 'DB' | 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>, appId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT e.product_key, e.subject, e.status, e.period_end, e.grace_until, e.renews, e.buyer_user_id, e.version, e.updated_at
       FROM app_entitlements e LEFT JOIN app_billing b ON b.app_id = e.app_id
      WHERE e.app_id = ?1 AND e.mirrored_version < e.version AND e.stripe_env = COALESCE(b.stripe_env, 'live')
      ORDER BY e.version, e.product_key, e.subject LIMIT ${MIRROR_BATCH}`,
  ).bind(appId).all<MirrorRow>();
  const rows = results ?? [];
  if (rows.length === 0) return 0;

  let ok = false;
  try {
    const statements = mirrorStatements(rows, await existingColumns(env, appId));
    const res = await forwardToDataWorker(env as Env, appId, 'batch', { statements }, null);
    ok = res.ok;
    if (!ok) console.warn('[billing] mirror push refused', { appId, status: res.status });
  } catch (e) {
    console.warn('[billing] mirror push failed', { appId, error: e instanceof Error ? e.message : String(e) });
  }
  if (!ok) return 0;

  // Mark exactly the version that was pushed, within the env that was active when it was selected above: a row that
  // changed while the push was in flight stays dirty, and a row of the OTHER env is never touched.
  await env.DB.batch(rows.map((r) => env.DB.prepare(
    `UPDATE app_entitlements SET mirrored_version = ?1 WHERE app_id = ?2 AND product_key = ?3 AND subject = ?4 AND mirrored_version < ?1
       AND stripe_env = COALESCE((SELECT stripe_env FROM app_billing WHERE app_id = ?2), 'live')`,
  ).bind(r.version, appId, r.product_key, r.subject)));
  return rows.length;
}

/** Push every app that has dirty rows (in its currently-active env, #519), a bounded number per call. */
export async function mirrorDirtyApps(env: Pick<Env, 'DB' | 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>): Promise<{ apps: number; rows: number }> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT e.app_id FROM app_entitlements e LEFT JOIN app_billing b ON b.app_id = e.app_id
      WHERE e.mirrored_version < e.version AND e.stripe_env = COALESCE(b.stripe_env, 'live') LIMIT ${MIRROR_APPS_PER_SWEEP}`,
  ).all<{ app_id: string }>();
  let rows = 0;
  let apps = 0;
  for (const { app_id } of results ?? []) {
    const n = await mirrorApp(env, app_id);
    if (n > 0) { apps++; rows += n; }
  }
  return { apps, rows };
}
