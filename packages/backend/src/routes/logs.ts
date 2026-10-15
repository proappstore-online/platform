/**
 * App log ingestion + query (ADR-008, platform#105/#106/#108).
 *
 * Ingestion is deliberately open to *signed-out* callers and deliberately not
 * open to arbitrary app ids. Those pull in opposite directions, so the trust
 * model is worth stating plainly:
 *
 *  - **Identity is optional.** A white screen on load and a failed credential
 *    sign-in have no session by definition, and they are the reports most worth
 *    having. Requiring auth here would 401 away exactly the evidence #105/#106
 *    exist to collect.
 *  - **App context is verified where the host can vouch for it.** A request
 *    arriving through same-origin mediation carries `X-PAS-App`, injected by the
 *    host from the resolved route and unspoofable by page JS. Those rows are
 *    marked `mediated`. A direct API call cannot prove its app, so its rows are
 *    marked `direct` and the console can prefer verified rows.
 *  - **Volume is capped per app per day**, because the realistic flood is an app
 *    stuck in an error loop, not an attacker.
 *
 * Reads stay owner-only, unchanged.
 */

import { Hono } from 'hono';
import {
  APP_CONTEXT_HEADER,
  HOST_DATA_PLANE_FAILURE_HEADER,
  HOST_SESSION_INVALIDATION_HEADER,
  HOST_SESSION_INVALIDATION_ID_HEADER,
} from '../lib/app-context.js';
import { HttpError, optionalUser, requireAppOwner } from '../lib/auth.js';
import {
  MAX_BODY_BYTES,
  METRIC_LEVELS,
  normalizeBatch,
  normalizeClientId,
  parseTraceparent,
  traceIdFromTraceparent,
  type RawLogEntry,
} from '../lib/log-ingest.js';
import { dataFaultOf } from '../lib/data-worker-url.js';
import { recordDataPlaneFailure } from '../lib/operation-log.js';
import { incrementMetrics } from '../lib/metric-aggregates.js';
import { checkLogQuota, d1LogUsageStore, publicLogBurstKey, SERVER_FAILURE_DAILY_LIMIT, serverFailureUsageStore } from '../lib/log-quota.js';
import type { Env } from '../types.js';
import { privateNoStore } from '../lib/route-wrap.js';

export const logsRoutes = new Hono<{ Bindings: Env }>();
// #378: owner-only reads are never cached.
logsRoutes.use('/apps/:appId/logs', privateNoStore);
logsRoutes.use('/apps/:appId/logs/*', privateNoStore);
logsRoutes.use('/apps/:appId/incidents/*', privateNoStore);

const MAX_LOG_PAGE_SIZE = 100;
const SESSION_INVALIDATION_ID_RE = /^[a-f0-9]{32}$/i;
const HOST_INVALIDATION_BURST_KEY = 'host:session-invalidation';
const CF_RAY_RE = /^[0-9a-f]{16}(-[A-Z]{3})?$/i;
/** An incident id: a W3C trace id, a #353 correlation id or a #308 invocation id. */
const INCIDENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_INCIDENT_RECORDS = 200;

/** A log cursor is deliberately only its stable ordering fields, never identity. */
function parseLogCursor(raw: string | undefined): { ts: number; id: number } | null {
  if (!raw || !/^\d{1,16}:\d{1,16}$/.test(raw)) return null;
  const parts = raw.split(':');
  const ts = Number(parts[0] ?? NaN);
  const id = Number(parts[1] ?? NaN);
  return Number.isSafeInteger(ts) && Number.isSafeInteger(id) ? { ts, id } : null;
}

function boundedPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/**
 * The app host calls this only through the private HostApi service binding
 * immediately after an authoritative API-plane 401 and before it clears the
 * browser cookie. The default API entrypoint strips both marker headers, so an
 * Internet request cannot forge this server-side row.
 */
logsRoutes.post('/internal/session-invalidations', async (c) => {
  const appId = c.req.header(APP_CONTEXT_HEADER);
  const reason = c.req.header(HOST_SESSION_INVALIDATION_HEADER);
  const correlationId = c.req.header(HOST_SESSION_INVALIDATION_ID_HEADER);
  if (!appId || reason !== 'api_401' || !correlationId || !SESSION_INVALIDATION_ID_RE.test(correlationId)) {
    throw new HttpError('host session invalidation required', 403);
  }

  const now = Date.now();
  // A source = 'server' row: it spends the server budget (#372), which anonymous
  // POST /logs cannot exhaust, not the client-ingestion `count`.
  const quota = await checkLogQuota(serverFailureUsageStore(c.env.DB), {
    appId,
    clientKey: HOST_INVALIDATION_BURST_KEY,
    entries: 1,
    nowMs: now,
    dailyLimit: SERVER_FAILURE_DAILY_LIMIT,
  });
  // The host's authoritative 401 and cookie clearing must never be held up by
  // diagnostics. The bounded row is best-effort, just like browser telemetry.
  if (!quota.persist) return c.body(null, 204);
  await c.env.DB.prepare(
    `INSERT INTO app_logs
       (app_id, user_id, client_id, ts, level, category, message, data, build_meta,
        fingerprint, trace_id, source, ingested_at)
     VALUES (?, NULL, NULL, ?, 'warn', 'auth.session_lost', ?, ?, NULL, ?, ?, 'server', ?)`,
  )
    .bind(
      appId,
      now,
      'PAS session was invalidated by an API response',
      JSON.stringify({ reason: 'api_401', phase: 'api_request', route: 'platform.api' }),
      'auth-session-api-401',
      correlationId.toLowerCase(),
      now,
    )
    .run();

  return c.body(null, 204);
});

/**
 * #394: the host's report of a browser data-plane 5xx — the one hop the API never
 * sees, since browser `app.db` calls go host → data worker. Same trust model as
 * session invalidations above: the marker and X-PAS-App survive only on the
 * private HostApi entrypoint. The body names the status, the data worker's fault
 * verdict and endpoint; the host's forwarded traceparent names the trace.
 */
logsRoutes.post('/internal/data-plane-failures', async (c) => {
  const appId = c.req.header(APP_CONTEXT_HEADER);
  if (!appId || c.req.header(HOST_DATA_PLANE_FAILURE_HEADER) !== '1') {
    throw new HttpError('host data-plane failure required', 403);
  }
  const body = await c.req.json<{ status?: unknown; fault?: unknown; endpoint?: unknown; cfRay?: unknown }>().catch(() => null);
  const status = body?.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 500 || status > 599) {
    throw new HttpError('5xx status required', 400);
  }
  const trace = parseTraceparent(c.req.header('traceparent'));
  await recordDataPlaneFailure(c.env, {
    appId,
    status,
    fault: dataFaultOf(typeof body?.fault === 'string' ? body.fault : null),
    endpoint: typeof body?.endpoint === 'string' ? body.endpoint : '',
    traceId: trace?.traceId ?? null,
    parentSpanId: trace?.spanId ?? null,
    cfRay: typeof body?.cfRay === 'string' && CF_RAY_RE.test(body.cfRay) ? body.cfRay : null,
  });
  return c.body(null, 204);
});

logsRoutes.post('/apps/:appId/logs', async (c) => {
  const appId = c.req.param('appId')!;

  // A mediated request must not lie about which app it is. Mismatch means either
  // a bug or an attempt to write across tenants through the trusted path.
  const mediatedApp = c.req.header(APP_CONTEXT_HEADER);
  if (mediatedApp && mediatedApp !== appId) {
    throw new HttpError('app context mismatch', 403);
  }
  const source = mediatedApp ? 'mediated' : 'direct';

  // The app must exist. Without this, rows pile up against never-provisioned ids
  // that no owner can read and no pruning pass attributes to anyone.
  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ id: string }>();
  if (!app) throw new HttpError('app not found', 404);

  const declaredLength = Number(c.req.header('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HttpError('payload too large', 413);
  }

  const body = await c.req
    .json<{ entries?: RawLogEntry[]; clientId?: unknown }>()
    .catch(() => null);
  if (!body?.entries || !Array.isArray(body.entries)) {
    throw new HttpError('entries array required', 400);
  }

  const user = await optionalUser(c);
  const clientId = normalizeClientId(body.clientId);
  const now = Date.now();
  const entries = await normalizeBatch(body.entries, now);
  if (entries.length === 0) return c.json({ ok: true, ingested: 0 });

  // Quota key: the session if there is one, else the client id, else the edge IP.
  // Never *only* the app, or one noisy client would spend every other user's
  // burst budget for that app. Namespaced (#316): see publicLogBurstKey.
  const clientKey = publicLogBurstKey(user?.id, clientId, c.req.header('cf-connecting-ip'));
  const verdict = await checkLogQuota(d1LogUsageStore(c.env.DB), {
    appId,
    clientKey,
    entries: entries.length,
    nowMs: now,
  });

  // Metrics tier first, and regardless of the quota verdict: a throttled app is
  // precisely when the error *rate* still needs to be visible. AE carries no
  // identity (ADR-008 §2), so this stays PII-free.
  const dataset = c.env.ERRORS;
  if (dataset) {
    for (const e of entries) {
      if (!METRIC_LEVELS.includes(e.level)) continue;
      try {
        dataset.writeDataPoint({
          indexes: [appId.slice(0, 96)],
          blobs: [
            'sdk',
            e.level,
            e.category,
            e.fingerprint,
            source,
            e.traceId ?? '',
            verdict.persist ? 'persisted' : verdict.reason,
          ],
          doubles: [1, e.ts],
        });
      } catch {
        // Telemetry never fails an ingest.
      }
    }
  }

  // #391: the incident counters, regardless of the detail verdict. Public
  // ingestion is untrusted, so it can only ever add client_* signals.
  const clientErrors = entries.filter((e) => e.level === 'error').length;
  await incrementMetrics(c.env.DB, appId, {
    client_error: clientErrors,
    ...(verdict.persist ? {} : { detail_dropped_client: entries.length }),
  }, now);

  if (!verdict.persist) {
    // 202, not 429: the entries were accepted as signal and deliberately not
    // stored in detail. A 4xx would make well-behaved SDKs retry a flood.
    return c.json(
      { ok: true, ingested: 0, counted: entries.length, throttled: verdict.reason },
      202,
    );
  }

  const stmt = c.env.DB.prepare(
    `INSERT INTO app_logs
       (app_id, user_id, client_id, ts, level, category, message, data, build_meta,
        fingerprint, trace_id, source, ingested_at, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const requestTraceId = traceIdFromTraceparent(c.req.header('traceparent'));

  const batch = entries.map((e) =>
    stmt.bind(
      appId,
      user?.id ?? null,
      clientId,
      e.ts,
      e.level,
      e.category,
      e.message,
      e.data,
      e.buildMeta,
      e.fingerprint,
      e.traceId ?? requestTraceId,
      source,
      now,
      e.context,
    ),
  );
  await c.env.DB.batch(batch);

  return c.json({ ok: true, ingested: batch.length });
});

logsRoutes.get('/apps/:appId/logs', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const level = c.req.query('level');
  const category = c.req.query('category');
  // `phase` is an allowlisted #353 telemetry field inside the sanitized data
  // envelope. Keep it parameterized: it is never interpolated into SQL.
  const phase = c.req.query('phase');
  const since = c.req.query('since');
  const limit = boundedPositiveInt(c.req.query('limit'), MAX_LOG_PAGE_SIZE, MAX_LOG_PAGE_SIZE);
  const userId = c.req.query('user_id');
  const clientId = c.req.query('client_id');
  const fingerprint = c.req.query('fingerprint');
  const sourceFilter = c.req.query('source');
  // #308: an app worker invocation's lines (PAS.log and its console) carry trace_id = the invocation id.
  const traceId = c.req.query('trace_id');
  const cursor = parseLogCursor(c.req.query('cursor'));

  let sql = `SELECT id, ts, level, category, message, data, user_id, client_id, build_meta,
                    fingerprint, trace_id, source, context
             FROM app_logs WHERE app_id = ?`;
  const params: unknown[] = [appId];

  if (level) { sql += ' AND level = ?'; params.push(level); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (phase) { sql += " AND CASE WHEN json_valid(data) THEN json_extract(data, '$.phase') END = ?"; params.push(phase); }
  if (since) { sql += ' AND ts >= ?'; params.push(Number(since)); }
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  if (fingerprint) { sql += ' AND fingerprint = ?'; params.push(fingerprint); }
  if (sourceFilter) { sql += ' AND source = ?'; params.push(sourceFilter); }
  if (traceId) { sql += ' AND trace_id = ?'; params.push(traceId); }
  if (cursor) {
    sql += ' AND (ts < ? OR (ts = ? AND id < ?))';
    params.push(cursor.ts, cursor.ts, cursor.id);
  }

  // Ask for one extra row so the UI can show a truthful, bounded next page.
  sql += ' ORDER BY ts DESC, id DESC LIMIT ?';
  params.push(limit + 1);

  const result = await c.env.DB.prepare(sql).bind(...params).all();
  const rows = (result.results ?? []) as Record<string, unknown>[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return c.json({
    logs: page.map((r) => {
      let data: unknown;
      let build: unknown;
      let context: unknown = null;
      if (r.data) { try { data = JSON.parse(r.data as string); } catch { data = null; } }
      if (r.build_meta) { try { build = JSON.parse(r.build_meta as string); } catch { build = null; } }
      if (r.context) { try { context = JSON.parse(r.context as string); } catch { context = null; } }
      return {
        ts: r.ts,
        level: r.level,
        category: r.category,
        message: r.message,
        data,
        userId: r.user_id,
        clientId: r.client_id,
        build,
        fingerprint: r.fingerprint,
        traceId: r.trace_id,
        source: r.source,
        // #390: the row's allowlisted request context (span, operation, error code…); null before the envelope.
        context,
      };
    }),
    nextCursor: rows.length > limit && last
      ? `${String(last.ts)}:${String(last.id)}`
      : null,
  });
});

/**
 * Error groups for an app — occurrences collapsed by fingerprint.
 *
 * The unit the console and any spike check actually reason about. A flat row list
 * can say "400 errors"; this says "*this* error, 400 times, 12 clients, first
 * seen 14:02" — the difference between a firehose and a diagnosis.
 */
logsRoutes.get('/apps/:appId/logs/groups', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const since = Number(c.req.query('since') || Date.now() - 24 * 60 * 60 * 1000);
  const limit = boundedPositiveInt(c.req.query('limit'), 50, 200);
  const level = c.req.query('level');
  const category = c.req.query('category');
  const phase = c.req.query('phase');
  const clientId = c.req.query('client_id');
  const fingerprint = c.req.query('fingerprint');
  const sourceFilter = c.req.query('source');
  const traceId = c.req.query('trace_id');

  let sql = `SELECT fingerprint,
            COUNT(*) AS occurrences,
            COUNT(DISTINCT COALESCE(user_id, client_id)) AS affected,
            MIN(ts) AS first_seen,
            MAX(ts) AS last_seen,
            MAX(level) AS level,
            MAX(category) AS category,
            MAX(message) AS sample_message
     FROM app_logs
     WHERE app_id = ? AND fingerprint IS NOT NULL AND ts >= ? AND level IN ('warn', 'error')`;
  const params: unknown[] = [appId, since];

  if (level) { sql += ' AND level = ?'; params.push(level); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (phase) { sql += " AND CASE WHEN json_valid(data) THEN json_extract(data, '$.phase') END = ?"; params.push(phase); }
  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }
  if (fingerprint) { sql += ' AND fingerprint = ?'; params.push(fingerprint); }
  if (sourceFilter) { sql += ' AND source = ?'; params.push(sourceFilter); }
  if (traceId) { sql += ' AND trace_id = ?'; params.push(traceId); }
  sql += ' GROUP BY fingerprint ORDER BY occurrences DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all();

  return c.json({ groups: result.results ?? [], since });
});

logsRoutes.get('/apps/:appId/logs/build', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const row = await c.env.DB.prepare(
    `SELECT build_meta, ts FROM app_logs
     WHERE app_id = ? AND build_meta IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  )
    .bind(appId)
    .first<{ build_meta: string; ts: number }>();

  if (!row) return c.json({ build: null });
  let build: unknown = null;
  try { build = JSON.parse(row.build_meta); } catch { /* corrupted JSON — return null */ }
  return c.json({ build, ts: row.ts });
});

/** Which hop a log row is evidence from (#394). */
function hopOf(source: unknown, category: unknown, data: unknown): string {
  if (source === 'mediated' || source === 'direct') return 'browser';
  if (source === 'worker-console' || category === 'worker') return 'app-worker';
  if (category === 'auth.session_lost') return 'host';
  if ((data as { route?: unknown } | null)?.route === 'platform.data') return 'data-worker';
  return 'api';
}

/**
 * One incident, every hop (#394): the app's log rows that share an id, oldest
 * first, each labelled with the hop it is evidence from, plus the app-worker
 * invocation of that id with its CPU/wall/outcome (#308).
 *
 * The id is whatever the rows were stored under: a W3C trace id (#390), the
 * anonymous session-loss correlation id (#353) or an invocation id (#308) — old
 * ids keep working because the lookup is by stored value. Owner-only, scoped to
 * this app on every query, so owner A's id cannot surface app B's rows.
 *
 * A hop with no row is a gap, not an all-clear: browser rows are best-effort,
 * detail rows are budgeted, and a hop that succeeded writes none.
 */
logsRoutes.get('/apps/:appId/incidents/:traceId', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const raw = c.req.param('traceId')!;
  if (!INCIDENT_ID_RE.test(raw)) throw new HttpError('invalid trace id', 400);
  // W3C and #353 ids are stored lower-case hex; any other id is matched as stored.
  const traceId = /^[0-9a-f]{32}$/i.test(raw) ? raw.toLowerCase() : raw;

  const [logs, invocation] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, ts, level, category, message, data, build_meta, fingerprint, source, context
         FROM app_logs WHERE app_id = ? AND trace_id = ?
        ORDER BY ts ASC, id ASC LIMIT ?`,
    ).bind(appId, traceId, MAX_INCIDENT_RECORDS + 1).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, type, name, status, http_status, started_at, finished_at,
              child_cpu_ms, child_wall_ms, child_outcome
         FROM app_worker_invocations WHERE app_id = ? AND id = ?`,
    ).bind(appId, traceId).first<Record<string, unknown>>(),
  ]);

  const rows = logs.results ?? [];
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return null;
    try { return JSON.parse(v); } catch { return null; }
  };
  const records = rows.slice(0, MAX_INCIDENT_RECORDS).map((r) => {
    const data = parse(r.data);
    return {
      ts: r.ts,
      hop: hopOf(r.source, r.category, data),
      source: r.source,
      level: r.level,
      category: r.category,
      message: r.message,
      data,
      build: parse(r.build_meta),
      fingerprint: r.fingerprint,
      context: parse(r.context),
    };
  });
  const hops: Record<string, number> = {};
  for (const r of records) hops[r.hop] = (hops[r.hop] ?? 0) + 1;

  return c.json({
    traceId,
    hops,
    records,
    invocation: invocation
      ? {
          id: invocation.id,
          type: invocation.type,
          name: invocation.name,
          status: invocation.status,
          httpStatus: invocation.http_status,
          startedAt: invocation.started_at,
          finishedAt: invocation.finished_at,
          cpuMs: invocation.child_cpu_ms,
          wallMs: invocation.child_wall_ms,
          outcome: invocation.child_outcome,
        }
      : null,
    truncated: rows.length > MAX_INCIDENT_RECORDS,
  });
});
