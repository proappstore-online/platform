/**
 * Server-side logging of failed app operations (ADR-008 step 3, platform#106).
 *
 * #106 proposed instrumenting the SDK to report its own failures. Inverted here:
 * the backend already sees the action name, HTTP status, user, app, and role on
 * every call, so recording it server-side is
 *
 *   - **unspoofable** — the client cannot fabricate the status or the identity;
 *   - **retroactive** — it covers apps already deployed, with no SDK release;
 *   - **complete** — it cannot be skipped by an app that catches its own errors,
 *     which is how most production failures actually surface (a handled rejection
 *     the UI turns into a message).
 *
 * Client-side capture is still needed, but only for the residue: failures that
 * never reach the API at all (client-side throws, offline, network).
 *
 * Rows land in `app_logs` beside client entries with `source = 'server'` — the
 * same table because it is the same question an owner is asking, and one query
 * should answer it. `server` is the most trustworthy of the three sources.
 */

import { hash16, redact } from './error-telemetry.js';
import { messageShape } from './log-ingest.js';
import { checkLogQuota, d1LogUsageStore } from './log-quota.js';

/** Route families worth logging, keyed by the segment after `/apps/:appId/`.
 *  Anything not listed falls back to the segment itself, so a new route is
 *  captured with a sane category rather than silently ignored. */
const CATEGORY_BY_SEGMENT: Record<string, string> = {
  actions: 'action',
  db: 'db',
  rooms: 'rooms',
  invites: 'invites',
  roles: 'roles',
  storage: 'storage',
  kv: 'kv',
  counters: 'counters',
  logs: 'logs',
  qa: 'qa',
};

export interface OperationContext {
  method: string;
  /** Hono route *pattern*, e.g. `/v1/apps/:appId/actions/:name`. */
  routePath: string;
  /** Concrete path params, so `:name` can name the action that failed. */
  params: Record<string, string | undefined>;
}

/**
 * Should this failure be recorded?
 *
 * Mutations are logged from 400 up: a failed write is an *operation* that did not
 * happen, which is what support is asked about. Reads are logged only from 500:
 * a 401 or 404 on a GET is ordinary browsing noise, and logging it would bury the
 * signal in exactly the way #107's alerting cannot tolerate.
 */
export function shouldLogOperationFailure(method: string, status: number, routePath = ''): boolean {
  if (status < 400) return false;
  // The log endpoints are excluded: a failed log upload writing a log row is
  // circular, and it would let a caller generate rows by sending malformed
  // bodies. Ingestion reports its own outcome in the response instead.
  if (/\/apps\/:appId\/logs(\/|$)/.test(routePath)) return false;
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  return mutating ? true : status >= 500;
}

/** `/v1/apps/:appId/actions/:name` + `{name: 'provision_student'}` →
 *  `{category: 'action', operation: 'provision_student'}`. */
export function classifyOperation(ctx: OperationContext): { category: string; operation: string } {
  const match = ctx.routePath.match(/\/apps\/:appId\/([^/]+)(?:\/(.*))?$/);
  if (!match) return { category: 'app', operation: `${ctx.method} ${ctx.routePath}` };

  const segment = match[1];
  const category = CATEGORY_BY_SEGMENT[segment] ?? segment;

  // Prefer a concrete name (the action, the flow) over the pattern — an owner
  // needs to know *which* action failed, not that "an action" did.
  const named = ctx.params.name ?? ctx.params.flowId ?? ctx.params.key;
  const tail = match[2] ? match[2].replace(/:/g, '') : '';
  const operation = named ?? (tail ? `${segment}.${tail}` : `${ctx.method.toLowerCase()}.${segment}`);
  return { category, operation };
}

export interface OperationFailure extends OperationContext {
  appId: string;
  userId: string | null;
  status: number;
  /** Error message as thrown. Redacted here before it is persisted. */
  message: string;
  traceId?: string | null;
  cfRay?: string | null;
  /** True when the request came through the host's same-origin mediation, which
   *  is also how we infer the SDK's auth mode (#106 asks for it and the server
   *  cannot observe it directly). */
  mediated?: boolean;
}

/**
 * Record one failed app operation. Never throws.
 *
 * Shares the per-app daily budget with client ingestion, so the cost bound for an
 * app stays a single number. Over budget, the AE count still lands and only the
 * detail row is dropped.
 */
export async function recordOperationFailure(
  env: { DB: D1Database; ERRORS?: AnalyticsEngineDataset },
  failure: OperationFailure,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const { category, operation } = classifyOperation(failure);
    const level = failure.status >= 500 ? 'error' : 'warn';
    const message = redact(failure.message).slice(0, 1024);
    const fingerprint = await hash16([
      category,
      operation,
      String(failure.status),
      messageShape(message),
    ]);
    const authMode = failure.mediated ? 'platform-cookie' : 'legacy-bearer';

    if (env.ERRORS) {
      try {
        env.ERRORS.writeDataPoint({
          indexes: [failure.appId.slice(0, 96)],
          blobs: [
            'server',
            level,
            category,
            fingerprint,
            operation,
            String(failure.status),
            authMode,
          ],
          doubles: [1, failure.status],
        });
      } catch {
        // Metrics are best-effort.
      }
    }

    // Rows require an authenticated caller; counts do not.
    //
    // `source = 'server'` is the most trustworthy tier an owner can filter on, so
    // it must not be mintable by anyone. Without this, any caller could POST junk
    // to `/v1/apps/<victim>/actions/x`, take the 400, and write a row into that
    // app's log — exactly the cross-app spoofing #108 closed, reintroduced
    // through the trusted path. An unauthenticated 4xx is usually probing anyway;
    // it is still counted in Analytics Engine above, so a spike stays visible.
    if (!failure.userId) return;

    const verdict = await checkLogQuota(d1LogUsageStore(env.DB), {
      appId: failure.appId,
      // A dedicated key so server records do not spend a user's burst budget,
      // while still drawing on the app's daily total.
      clientKey: 'server',
      entries: 1,
      nowMs,
    });
    if (!verdict.persist) return;

    // Structured context, no params and no bodies: #106 is explicit that request
    // payloads, SQL params, and credential fields must never be logged. What an
    // owner needs is which operation, which status, which mode — not the data.
    const data = JSON.stringify({
      operation,
      status: failure.status,
      authMode,
      route: failure.routePath,
      method: failure.method,
      cfRay: failure.cfRay ?? null,
    });

    await env.DB.prepare(
      `INSERT INTO app_logs
         (app_id, user_id, client_id, ts, level, category, message, data, build_meta,
          fingerprint, trace_id, source, ingested_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, 'server', ?)`,
    )
      .bind(
        failure.appId,
        failure.userId,
        nowMs,
        level,
        category,
        message,
        data,
        fingerprint,
        failure.traceId ?? null,
        nowMs,
      )
      .run();
  } catch {
    // Logging a failure must never turn it into a different failure.
  }
}

/**
 * Record a platform-scoped auth failure — no app, so metrics only.
 *
 * `app_logs.app_id` is NOT NULL and a credential sign-in is not app-scoped, so
 * these are counted in Analytics Engine under the `platform` index rather than
 * stored as rows. That is enough for the thing we currently cannot see at all:
 * platform#89's per-login lockout, where a known login can be locked out and
 * nothing anywhere records the pattern.
 *
 * Deliberately carries no login, no identifier, and no password material — only
 * the reason and the status.
 */
export async function recordAuthFailure(
  env: { ERRORS?: AnalyticsEngineDataset },
  failure: { reason: string; status: number; cfRay?: string | null; traceId?: string | null },
): Promise<void> {
  try {
    if (!env.ERRORS) return;
    const fingerprint = await hash16(['auth.credentials', failure.reason, String(failure.status)]);
    env.ERRORS.writeDataPoint({
      indexes: ['platform'],
      blobs: [
        'server',
        'warn',
        'auth.credentials',
        fingerprint,
        failure.reason,
        String(failure.status),
        failure.cfRay ?? '',
      ],
      doubles: [1, failure.status],
    });
  } catch {
    // Best-effort.
  }
}
