/**
 * Incident counters independent of retained detail rows (#391).
 *
 * `app_logs` rows are budgeted (client and server daily caps, burst limits), so
 * counting rows undercounts a failing app. Recorders add to these per-app
 * 5-minute counters first, then decide on detail. The signal set is fixed here,
 * so the table's cardinality is apps × buckets × signals and nothing else.
 *
 * Trust: `client_*` signals come from public ingestion and are untrusted by
 * nature; every other signal is written only by the API's own recorders or the
 * host's HostApi report, so public ingestion can neither raise nor suppress them.
 */

export const METRIC_BUCKET_MS = 5 * 60_000;

export const METRIC_SIGNALS = [
  /** Client-reported `error` entries (untrusted, public ingestion). */
  'client_error',
  /** Client entries withheld from detail by burst or daily budget. */
  'detail_dropped_client',
  /** Server-observed failed app operations on the actions route (any status). */
  'action_failure',
  /** Server-observed 5xx that is the platform's (or unverdicted, #394). */
  'server_5xx',
  /** A data-worker 5xx caused by the app's own SQL (#394). */
  'tenant_fault',
  /** A data-worker 5xx caused by a malformed request (#394). */
  'client_fault',
  /** Server failure rows withheld from detail by the server budget. */
  'detail_dropped_server',
] as const;

export type MetricSignal = (typeof METRIC_SIGNALS)[number];

export function metricBucket(nowMs: number): number {
  return Math.floor(nowMs / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
}

/** #391: the fixed latency bucket of a request's wall time (request metrics, AE). */
export function latencyBucket(ms: number): 'lt_100ms' | 'lt_500ms' | 'lt_2s' | 'ge_2s' {
  return ms < 100 ? 'lt_100ms' : ms < 500 ? 'lt_500ms' : ms < 2000 ? 'lt_2s' : 'ge_2s';
}

/**
 * Add `counts` to `appId`'s current bucket in one D1 batch, and stamp the app's
 * `aggregates` health. Callers have already established that the app exists.
 *
 * Never throws. A failed write is stamped as the app's `aggregates` failure when
 * D1 still accepts that; when it does not, the stamp goes stale and the health
 * API reports unknown rather than healthy.
 */
export async function incrementMetrics(
  db: D1Database,
  appId: string,
  counts: Partial<Record<MetricSignal, number>>,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const entries = Object.entries(counts).filter(([, n]) => typeof n === 'number' && n > 0) as [MetricSignal, number][];
  if (entries.length === 0) return true;
  try {
    const stmt = db.prepare(
      `INSERT INTO app_metric_buckets (app_id, bucket_start, signal, n) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(app_id, bucket_start, signal) DO UPDATE SET n = n + excluded.n`,
    );
    const bucket = metricBucket(nowMs);
    await db.batch([
      ...entries.map(([signal, n]) => stmt.bind(appId, bucket, signal, Math.floor(n))),
      healthStatement(db, 'aggregates', appId, true, null, nowMs),
    ]);
    return true;
  } catch (e) {
    console.error('[metric-aggregates] increment failed', { appId, err: String(e).slice(0, 200) });
    await recordHealth(db, 'aggregates', appId, false, 'write_failed', nowMs);
    return false;
  }
}

/** Pipeline components whose health is recorded (#391). `''` app id = platform-wide. */
export type HealthComponent = 'aggregates' | 'evaluator' | 'prune';

function healthStatement(db: D1Database, component: HealthComponent, appId: string, ok: boolean, error: string | null, nowMs: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO telemetry_health (component, app_id, last_ok_at, last_failure_at, last_error, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(component, app_id) DO UPDATE SET
       last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at),
       last_failure_at = COALESCE(excluded.last_failure_at, last_failure_at),
       last_error = CASE WHEN excluded.last_failure_at IS NOT NULL THEN excluded.last_error ELSE last_error END,
       updated_at = excluded.updated_at`,
  ).bind(component, appId, ok ? nowMs : null, ok ? null : nowMs, ok ? null : error, nowMs);
}

/** Stamp one component's success or failure. `error` is a short code, never a message with data. Never throws. */
export async function recordHealth(db: D1Database, component: HealthComponent, appId: string, ok: boolean, error: string | null, nowMs: number = Date.now()): Promise<void> {
  try {
    await healthStatement(db, component, appId, ok, error, nowMs).run();
  } catch (e) {
    console.error('[telemetry-health] write failed', { component, appId, err: String(e).slice(0, 200) });
  }
}
