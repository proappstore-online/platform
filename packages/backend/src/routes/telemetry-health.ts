/**
 * Telemetry health for one app (#391): is the pipeline behind its alerts and
 * counts working, and what did it count?
 *
 * The point is that "nothing happened" and "we cannot tell" look different:
 *  - `status: 'ok'` — the evaluator ran recently and nothing is failing, so a
 *    zero below is a real zero;
 *  - `status: 'degraded'` — a component's latest attempt failed (it clears on
 *    the next success);
 *  - `status: 'unknown'` — the evaluator has not succeeded recently (or ever),
 *    so counts below may be incomplete: `countsReliable` is false.
 *
 * `alertCoverage` is separate from all three: a scheduled-evaluator outage longer
 * than its catch-up horizon is recorded as a gap (#389) and then recovers, so
 * `status` is `ok` again while alerts for that range were never evaluated. Within
 * the last day it reads `complete: false` with the range, whatever `status` says.
 *
 * Owner-only and private. Failure counts come from the bounded per-app counters
 * (app_metric_buckets): fixed signal names, no ids, no paths. Request totals and
 * latency (the denominators) come from Analytics Engine, which samples: they are
 * weighted by _sample_interval, approximate, and `unknown` when AE cannot be
 * read — never reported as zero.
 */

import { Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { METRIC_SIGNALS, type HealthComponent, type MetricSignal } from '../lib/metric-aggregates.js';
import { privateNoStore } from '../lib/route-wrap.js';
import { REQUEST_METRICS_DATASET } from '../lib/telemetry-datasets.js';
import { cfAnalyticsSql } from './analytics-shared.js';
import type { Env } from '../types.js';

export const telemetryHealthRoutes = new Hono<{ Bindings: Env }>();
telemetryHealthRoutes.use('/apps/:appId/telemetry/*', privateNoStore);

/** The evaluator runs every five minutes; three missed ticks is stale. */
const EVALUATOR_STALE_MS = 15 * 60_000;
/** The prune runs daily (prune-app-logs.yml); two missed days is stale. */
const PRUNE_STALE_MS = 2 * 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
/** A recorded evaluation gap is reported while it ended within this window — the counters' `lastDay`. */
export const ALERT_COVERAGE_WINDOW_MS = 24 * HOUR;

interface CursorRow { gap_start: number | null; gap_end: number | null; gap_recorded_at: number | null }

/**
 * #391/#389: whether alerts were evaluated for every interval of the last day.
 * Incomplete while the last recorded gap ended within ALERT_COVERAGE_WINDOW_MS;
 * no cursor (never evaluated on schedule, or before migration 0106) is no recorded gap.
 */
export function alertCoverage(row: CursorRow | null | undefined, now: number) {
  const gapEnd = row?.gap_end ?? null;
  const recent = gapEnd !== null && now - gapEnd < ALERT_COVERAGE_WINDOW_MS;
  return {
    complete: !recent,
    windowMs: ALERT_COVERAGE_WINDOW_MS,
    gap: recent ? { start: row!.gap_start, end: gapEnd, recordedAt: row!.gap_recorded_at } : null,
  };
}

type ComponentStatus = 'ok' | 'degraded' | 'unknown' | 'no_data';
interface HealthRow { component: HealthComponent; app_id: string; last_ok_at: number | null; last_failure_at: number | null; last_error: string | null }

/** Latest attempt failed → degraded; no success, or none within `staleMs` → unknown. */
export function componentStatus(row: HealthRow | undefined, now: number, staleMs: number): ComponentStatus {
  if (!row) return 'unknown';
  if (row.last_failure_at !== null && (row.last_ok_at === null || row.last_failure_at > row.last_ok_at)) return 'degraded';
  if (row.last_ok_at === null || now - row.last_ok_at > staleMs) return 'unknown';
  return 'ok';
}

function summarise(sums: Map<MetricSignal, number>) {
  return {
    signals: Object.fromEntries(METRIC_SIGNALS.map((sig) => [sig, sums.get(sig) ?? 0])),
    detailDropped: { client: sums.get('detail_dropped_client') ?? 0, server: sums.get('detail_dropped_server') ?? 0 },
  };
}

type FamilyCounts = { total: number; ok: number; clientErrors: number; serverErrors: number; serverErrorRate: number | null };
type RequestWindow = FamilyCounts & { latency: Record<string, number>; byFamily: Record<string, FamilyCounts> };

/** Weighted request outcomes and latency buckets for one window, from AE. Throws when AE cannot be read. */
async function requestWindow(env: Env, appId: string, interval: '1' | '24'): Promise<RequestWindow> {
  const rows = await cfAnalyticsSql<{ outcome: string; latency: string; family: string; n: number | string }>(env,
    `SELECT blob1 AS outcome, blob2 AS latency, blob3 AS family, SUM(_sample_interval) AS n FROM ${REQUEST_METRICS_DATASET}
     WHERE index1 = '${appId}' AND timestamp > NOW() - INTERVAL '${interval}' HOUR GROUP BY outcome, latency, family`);
  const empty = (): FamilyCounts => ({ total: 0, ok: 0, clientErrors: 0, serverErrors: 0, serverErrorRate: null });
  const add = (c: FamilyCounts, outcome: string, n: number) => {
    c.total += n;
    if (outcome === 'ok') c.ok += n; else if (outcome === '4xx') c.clientErrors += n; else if (outcome === '5xx') c.serverErrors += n;
  };
  const w: RequestWindow = { ...empty(), latency: { lt_100ms: 0, lt_500ms: 0, lt_2s: 0, ge_2s: 0 }, byFamily: {} };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    add(w, r.outcome, n);
    if (r.latency in w.latency) w.latency[r.latency]! += n;
    // Points written before the family label read `unlabelled`, never as another family.
    add((w.byFamily[r.family || 'unlabelled'] ??= empty()), r.outcome, n);
  }
  // Numerator and denominator from the same points; null, not 0, when nothing was counted.
  for (const c of [w, ...Object.values(w.byFamily)]) c.serverErrorRate = c.total ? c.serverErrors / c.total : null;
  return w;
}

telemetryHealthRoutes.get('/apps/:appId/telemetry/health', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  if (!/^[a-z][a-z0-9-]{0,57}$/.test(appId)) throw new HttpError('invalid app id', 400);
  const now = Date.now();

  const [health, buckets, cursor] = await Promise.all([
    c.env.DB.prepare(
      `SELECT component, app_id, last_ok_at, last_failure_at, last_error FROM telemetry_health
        WHERE (app_id = '' AND component IN ('evaluator', 'prune')) OR (app_id = ? AND component = 'aggregates')`,
    ).bind(appId).all<HealthRow>(),
    // At most 288 buckets × the fixed signal set: bounded by construction.
    c.env.DB.prepare(
      `SELECT signal, SUM(CASE WHEN bucket_start >= ?2 THEN n ELSE 0 END) AS last_hour, SUM(n) AS last_day
         FROM app_metric_buckets WHERE app_id = ?1 AND bucket_start >= ?3 GROUP BY signal`,
    ).bind(appId, now - HOUR, now - 24 * HOUR).all<{ signal: MetricSignal; last_hour: number; last_day: number }>(),
    // One row by primary key: the scheduled evaluator's cursor (#389).
    c.env.DB.prepare("SELECT gap_start, gap_end, gap_recorded_at FROM alert_evaluator_cursor WHERE id = 'scheduled'").first<CursorRow>(),
  ]);

  const rows = health.results ?? [];
  const find = (component: HealthComponent) => rows.find((r) => r.component === component);
  const aggregatesRow = find('aggregates');
  const components = {
    evaluator: { status: componentStatus(find('evaluator'), now, EVALUATOR_STALE_MS), ...view(find('evaluator')) },
    prune: { status: componentStatus(find('prune'), now, PRUNE_STALE_MS), ...view(find('prune')) },
    // A quiet app writes nothing, so silence is not staleness here: never written is `no_data`.
    aggregates: { status: aggregatesRow ? componentStatus(aggregatesRow, now, Number.POSITIVE_INFINITY) : 'no_data' as const, ...view(aggregatesRow) },
  };
  const statuses = Object.values(components).map((x) => x.status);
  const status = components.evaluator.status === 'unknown' ? 'unknown' : statuses.includes('degraded') ? 'degraded' : 'ok';

  // App ids are slugs (requireAppOwner found the app); checked again before it goes into SQL text.
  const requests = await Promise.all([requestWindow(c.env, appId, '1'), requestWindow(c.env, appId, '24')])
    .then(([lastHour, lastDay]) => ({ status: 'ok' as const, sampled: true, lastHour, lastDay }))
    .catch(() => ({ status: 'unknown' as const, reason: 'analytics_unavailable', sampled: true, lastHour: null, lastDay: null }));
  const overall = status === 'ok' && requests.status === 'unknown' ? 'degraded' : status;

  const hour = new Map((buckets.results ?? []).map((r) => [r.signal, r.last_hour]));
  const day = new Map((buckets.results ?? []).map((r) => [r.signal, r.last_day]));
  return c.json({
    appId,
    checkedAt: now,
    status: overall,
    // False when the evaluator has not run recently: a zero below may be "unknown", not "none".
    countsReliable: status !== 'unknown',
    // Independent of status: a recovered outage can leave intervals whose alerts were never evaluated.
    alertCoverage: alertCoverage(cursor, now),
    components,
    windows: { lastHour: summarise(hour), lastDay: summarise(day) },
    requests,
    // Counters live in 5-minute buckets: the current bucket is partial.
    bucketMs: 5 * 60_000,
  });
});

function view(row: HealthRow | undefined) {
  return { lastOkAt: row?.last_ok_at ?? null, lastFailureAt: row?.last_failure_at ?? null, lastError: row?.last_error ?? null };
}
