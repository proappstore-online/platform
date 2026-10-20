import { WorkerEntrypoint } from 'cloudflare:workers';
import { APP_CONTEXT_HEADER, withoutHostContext } from './lib/app-context.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { HttpError, optionalUser } from './lib/auth.js';
import { checkSessionKeyDrift } from './lib/session-key-drift.js';
import { recordServerError } from './lib/error-telemetry.js';
import { requestTrace, safeErrorCode, TRACE_ID_HEADER } from './lib/log-ingest.js';
import { DataWorkerFailure, isPlatformFault } from './lib/data-worker-url.js';
import { recordOperationFailure, shouldLogOperationFailure } from './lib/operation-log.js';
import { latencyBucket, recordHealth, REQUEST_METRIC_FAMILIES } from './lib/metric-aggregates.js';
import type { Env } from './types.js';
import { openapiSpec, openapiYaml } from './openapi-spec.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { licenseRoutes } from './routes/license.js';
import { storageRoutes } from './routes/storage.js';
import { mapsRoutes } from './routes/maps.js';
import { provisionRoutes } from './routes/provision.js';
import { provisioningPlanRoutes, pruneProvisioningPlans } from './routes/provisioning-plans.js';
import { deployRoutes } from './routes/deploy.js';
import { webhookRoutes } from './routes/webhook.js';
import { notificationRoutes } from './routes/notifications.js';
import { smsRoutes } from './routes/sms.js';
import { aiRoutes } from './routes/ai.js';
import { submissionRoutes } from './routes/submissions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { appsRoutes } from './routes/apps.js';
import { listingsRoutes } from './routes/listings.js';
import { usageRoutes } from './routes/usage.js';
import { domainRoutes } from './routes/domains.js';
import { emailRoutes } from './routes/email.js';
import { webhookConfigRoutes } from './routes/webhooks-config.js';
import { logsRoutes } from './routes/logs.js';
import { logsPruneRoutes } from './routes/logs-prune.js';
import { telemetryHealthRoutes } from './routes/telemetry-health.js';
import { sourcemapRoutes } from './routes/sourcemaps.js';
import { appPermissionRoutes } from './routes/app-permissions.js';
import { marketingDeployRoutes } from './routes/marketing-deploy.js';
import { enquiryRoutes } from './routes/enquiries.js';
import { reliabilityRoutes } from './routes/reliability.js';
import { evaluateReliability } from './lib/reliability.js';
import { retryDueDeliveries } from './lib/webhook-dispatch.js';
import { sweepSourceMaps } from './lib/sourcemap.js';
import { toolsRoutes } from './routes/tools.js';
import { visibilityRoutes } from './routes/visibility.js';
import { endpointsRoutes } from './routes/endpoints.js';
import { tokenRoutes } from './routes/tokens.js';
import { oidcSessionRoutes } from './routes/oidc-session.js';
import { alertRoutes } from './routes/alerts.js';
import { scheduledRunsRoutes } from './routes/scheduled-runs.js';
import { pagsRoutes } from './routes/pags.js';
import { fallBackStalePagsRuns } from './lib/pags-runs.js';
import { operatorView } from './routes/operator-view.js';
import { evaluateErrorSpikes } from './lib/error-alerts.js';
import { runScheduledActions } from './lib/scheduled-actions.js';
import { reapReviewUploads } from './lib/review-storage-reaper.js';
import { handleAppEventBatch } from './lib/app-event-consumer.js';
import type { AppEventMessage } from './lib/app-event-queue.js';
import { checkAccountCeiling } from './lib/app-worker-usage.js';
import type { AppWorkerExports } from './lib/app-worker-host.js';
import { tokenUserFor } from './lib/app-tokens.js';
import { actionRoutes } from './routes/actions.js';
import { secretsRoutes } from './routes/secrets.js';
import { keysRoutes } from './routes/keys.js';
import { authRoutes } from './routes/auth.js';
import { cleanupRemoteAuthRequests, mcpBrokerRoutes } from './routes/mcp-broker.js';
import { mcpGrantRoutes } from './routes/mcp-grants.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { servicesRoutes } from './routes/services.js';
import { engagementRoutes } from './routes/engagements.js';
import { internalRoutes } from './routes/internal.js';
import { teamRoutes } from './routes/teams.js';
import { inviteRoutes } from './routes/invites.js';
import { rolesRoutes } from './routes/roles.js';
import { qaRoutes } from './routes/qa.js';
import { kvRoutes } from './routes/kv.js';
import { deleteAppAccountRoutes } from './routes/delete-app-account.js';
import { counterRoutes } from './routes/counters.js';
import { roomRoutes } from './routes/rooms.js';
import { appWorkerRoutes } from './routes/app-workers.js';
import { hookRoutes } from './routes/hooks.js';
import { connectorRoutes } from './routes/connectors.js';
import { ownershipRoutes } from './routes/ownership.js';
import { appDirectoryRoutes } from './routes/app-directory.js';

export const app = new Hono<{ Bindings: Env }>();

// CORS origin check — shared between middleware and onError handler.
// Active BYO domains are trusted browser origins for legacy-bearer SDK calls.
async function corsOrigin(env: Env, origin: string | undefined): Promise<string | null> {
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return origin;
    if (host.endsWith('.proappstore.online') || host === 'proappstore.online') return origin;
    // NOTE: freeappstore.online origins are intentionally NOT trusted — PAS's API
    // is separate from FreeAppStore (identity-separation, #61). A FAS-hosted page
    // cannot make credentialed cross-origin calls to the PAS API.
    if (host.endsWith('.pages.dev') && host.includes('proappstore')) return origin;
    if (await customDomainOriginAllowed(env.DB, host)) return origin;
    return null;
  } catch {
    return null;
  }
}

async function customDomainOriginAllowed(db: D1Database, hostname: string): Promise<boolean> {
  const host = hostname.replace(/\.$/, '');
  const firstDot = host.indexOf('.');
  const wildcardBase = firstDot > 0 ? host.slice(firstDot + 1) : '';

  const exactOrWildcardBase = await db.prepare(
    `SELECT 1 FROM app_custom_domains
     WHERE domain = ?1 AND status = 'active'
     LIMIT 1`,
  ).bind(host).first();
  if (exactOrWildcardBase) return true;
  if (!wildcardBase) return false;

  const wildcard = await db.prepare(
    `SELECT 1 FROM app_custom_domains
     WHERE domain = ?1 AND COALESCE(kind, 'exact') = 'wildcard' AND status = 'active'
     LIMIT 1`,
  ).bind(wildcardBase).first();
  return Boolean(wildcard);
}

app.use(
  '*',
  cors({
    origin: (origin, c) => corsOrigin(c.env, origin),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // traceparent (#390): the SDK's W3C trace context on platform calls.
    allowHeaders: ['Authorization', 'Content-Type', 'traceparent'],
    maxAge: 600,
  }),
);

/**
 * #391: app-scoped route families NOT counted as request outcomes — the
 * telemetry plane itself (ingesting logs would count itself; reading incidents,
 * health or alerts is not app traffic). Everything else under
 * `/v1/apps/:appId/…` is counted once, by status, with its latency bucket.
 * Also excluded: CORS preflights and WebSocket upgrades (101, long-lived).
 */
const REQUEST_METRIC_EXCLUDED = new Set(['logs', 'incidents', 'telemetry', 'alerts']);

app.use('/v1/apps/:appId/*', async (c, next) => {
  const started = Date.now();
  await next();
  const appId = c.req.param('appId');
  const status = c.res.status;
  // The id is whatever the URL said: only a well-formed app id is a label (bounded, no paths).
  if (!appId || !/^[a-z][a-z0-9-]{0,57}$/.test(appId) || c.req.method === 'OPTIONS' || status === 101
    || REQUEST_METRIC_EXCLUDED.has(c.req.path.split('/')[4] ?? '')) return;
  const ms = Date.now() - started;
  const segment = c.req.path.split('/')[4] ?? '';
  try {
    // One point per request, in its own dataset: outcome class, latency bucket and
    // operation family (no path, user or trace), the exact latency as a double.
    c.env.REQUEST_METRICS?.writeDataPoint({
      indexes: [appId],
      blobs: [status >= 500 ? '5xx' : status >= 400 ? '4xx' : 'ok', latencyBucket(ms), REQUEST_METRIC_FAMILIES.has(segment) ? segment : 'other'],
      doubles: [1, ms],
    });
  } catch {
    // Metrics never fail a request.
  }
});

/**
 * Run telemetry outside the response path.
 *
 * `c.executionCtx` *throws* when Hono is dispatched without a context —
 * `app.fetch(req, env)`, as tests and service-binding callers do — so it must be
 * guarded. Unguarded, any failure became a telemetry crash that replaced the real
 * response. The promise is left to settle on its own; every recorder here is
 * documented never to reject.
 */
function background(c: Context<{ Bindings: Env }>, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}

/** Caller id for an operation log, or null when unauthenticated. Must not throw:
 *  we are already on the error path. */
async function userIdForLog(c: Context<{ Bindings: Env }>): Promise<string | null> {
  // A personal app token (#154) has no session; the actions route noted its user.
  const tokenUser = tokenUserFor(c.req.raw);
  if (tokenUser) return tokenUser;
  const user = await optionalUser(c).catch(() => null);
  return user?.id ?? null;
}

app.onError(async (err, c) => {
  const status = err instanceof HttpError ? err.status as ContentfulStatusCode : 500;
  // #390: every error answers with a safe machine code and the trace it belongs
  // to — the caller's (a valid traceparent) or a fresh one — so a client can hand
  // the owner one id that finds the server's row. The server records its own
  // span, with the caller's as parent. Correlation only: nothing authorizes on it.
  // #394: the same trace and span a data-worker hop of this request was sent.
  const { traceId, spanId, parentSpanId } = requestTrace(c.req.raw);
  // #394: a data-worker 5xx is that worker's, with its own fault verdict, not the API's.
  const dataFailure = err instanceof DataWorkerFailure ? err : null;
  const errorCode = safeErrorCode(status, err instanceof HttpError ? err.message : null);
  const body = err instanceof HttpError
    ? { ...err.body, error: err.message, errorCode, traceId }
    : { error: 'Internal server error', errorCode, traceId };

  if (!(err instanceof HttpError)) console.error('Unhandled error:', err);

  // Make server failures countable, not just greppable (ADR-008 §1). Only 5xx:
  // a 4xx is an expected outcome, and indexing those would bury real faults.
  // Never awaited on the response path and never throws — see recordServerError.
  // A data-worker 5xx the worker blames on the app's SQL or the request is not a
  // server error (#394); the operation-failure point below still counts it, fault included.
  if (status >= 500 && (!dataFailure || isPlatformFault(dataFailure.fault))) {
    const written = recordServerError(c.env, {
      appId: c.req.param('appId') ?? null,
      service: dataFailure ? 'data-worker' : 'backend',
      method: c.req.method,
      // Route pattern, not concrete path: `/v1/apps/:appId/logs` groups, while
      // `/v1/apps/chess-academy/logs` mints one error group per app.
      routePath: c.req.routePath ?? c.req.path,
      status,
      errorType: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack ?? null : null,
      traceId,
      cfRay: c.req.header('cf-ray') ?? null,
    });
    background(c, written);
  }

  // Failed app *operations* — the majority of platform#106's value, recorded
  // server-side. Every app-scoped failure is a thrown HttpError passing through
  // here with the route pattern, status, and :appId already resolved, so one hook
  // covers actions, db, rooms, invites, roles and storage at once. Instrumenting
  // each route would be more code and would drift as routes are added.
  const appId = c.req.param('appId');
  if (appId && shouldLogOperationFailure(c.req.method, status, c.req.routePath)) {
    background(
      c,
      recordOperationFailure(c.env, {
        appId,
        userId: await userIdForLog(c),
        method: c.req.method,
        routePath: c.req.routePath ?? c.req.path,
        params: c.req.param() as Record<string, string | undefined>,
        status,
        message: err instanceof Error ? err.message : String(err),
        traceId,
        spanId,
        parentSpanId,
        errorCode,
        cfRay: c.req.header('cf-ray') ?? null,
        mediated: Boolean(c.req.header(APP_CONTEXT_HEADER)),
        fault: dataFailure?.fault ?? null,
      }),
    );
  }

  // CORS middleware doesn't run on error responses, so set headers here
  const origin = await corsOrigin(c.env, c.req.header('Origin'));
  const res = c.json(body, status);
  res.headers.set(TRACE_ID_HEADER, traceId);
  // A data-worker failure kept passThrough's no-store, so no cache keeps the error.
  if (dataFailure) res.headers.set('Cache-Control', 'no-store');
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent');
    res.headers.set('Access-Control-Expose-Headers', TRACE_ID_HEADER);
  }
  return res;
});

app.get('/', (c) => c.json({ ok: true, service: 'proappstore-api' }));
app.get('/health', (c) => c.json({ ok: true }));

// ── API documentation ──────────────────────────────────────────
// OpenAPI 3.1 spec (generated from the route table) + a browsable Swagger UI.
app.get('/openapi.json', (c) => c.json(openapiSpec));
app.get('/openapi.yaml', (c) =>
  c.body(openapiYaml, 200, { 'content-type': 'application/yaml; charset=utf-8' }),
);
app.get('/docs', (c) =>
  c.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ProAppStore API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`),
);

const v1 = new Hono<{ Bindings: Env }>();
v1.route('/', authRoutes);
v1.route('/', mcpBrokerRoutes);
v1.route('/', mcpGrantRoutes);
v1.route('/', passkeyRoutes);
v1.route('/', subscriptionRoutes);
v1.route('/', licenseRoutes);
v1.route('/', storageRoutes);
v1.route('/', mapsRoutes);
v1.route('/', provisionRoutes);
v1.route('/', provisioningPlanRoutes);
v1.route('/', deployRoutes);
v1.route('/', notificationRoutes);
v1.route('/', smsRoutes);
v1.route('/', aiRoutes);
v1.route('/', submissionRoutes);
v1.route('/', appDirectoryRoutes); // #424: before any /apps/:appId route
v1.route('/', appsRoutes);
v1.route('/', analyticsRoutes);
v1.route('/', listingsRoutes);
v1.route('/', usageRoutes);
v1.route('/', domainRoutes);
v1.route('/', emailRoutes);
v1.route('/', webhookConfigRoutes);
v1.route('/', logsRoutes);
v1.route('/', logsPruneRoutes);
v1.route('/', telemetryHealthRoutes);
v1.route('/', sourcemapRoutes);
v1.route('/', appPermissionRoutes);
v1.route('/', marketingDeployRoutes);
v1.route('/', enquiryRoutes);
v1.route('/', reliabilityRoutes);
v1.route('/', toolsRoutes);
v1.route('/', visibilityRoutes);
v1.route('/', endpointsRoutes);
v1.route('/', tokenRoutes);
v1.route('/', oidcSessionRoutes);
v1.route('/', alertRoutes);
v1.route('/', scheduledRunsRoutes);
v1.route('/', pagsRoutes);
v1.route('/', operatorView);
v1.route('/', actionRoutes);
v1.route('/', secretsRoutes);
v1.route('/', keysRoutes);
v1.route('/', servicesRoutes);
v1.route('/', engagementRoutes);
v1.route('/', internalRoutes);
v1.route('/', teamRoutes);
v1.route('/', inviteRoutes);
v1.route('/', rolesRoutes);
v1.route('/', qaRoutes);
v1.route('/', kvRoutes);
v1.route('/', deleteAppAccountRoutes);
v1.route('/', counterRoutes);
v1.route('/', roomRoutes);
v1.route('/', appWorkerRoutes);
v1.route('/', hookRoutes);
v1.route('/', connectorRoutes);
v1.route('/', ownershipRoutes);
app.route('/v1', v1);

// Stripe webhook is outside /v1 — it's not user-facing API
app.route('/', webhookRoutes);

export { Room } from './do/room.js';
// #254: the RPC entrypoint behind an app worker's `PAS` binding (ctx.exports.AppWorkerApi).
export { AppWorkerApi } from './rpc/app-worker-api.js';
// #311: the globalOutbound gateway of loaded app workers (ctx.exports.AppWorkerEgress).
export { AppWorkerEgress } from './rpc/app-worker-egress.js';
// #308: the Tail Worker of loaded app workers (ctx.exports.AppWorkerTail).
export { AppWorkerTail } from './rpc/app-worker-tail.js';

/**
 * #315: the host worker's way in. The host's `API` service binding names this
 * entrypoint (packages/host/wrangler.toml), and the Internet cannot reach a
 * named entrypoint — only the default export below. So this is the one path on
 * which X-PAS-App / X-PAS-Host arrive intact: the host sets them from the route
 * it resolved and strips any client copy (host platform-mediation.ts, index.ts).
 */
export class HostApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }
}

/**
 * Cron entry (#70): the session-key drift check. `[triggers] crons` in wrangler.toml
 * schedules it; the same function answers GET /v1/internal/session-key-drift on demand.
 * `fetch` stays the Hono app — tests and service-binding callers keep calling `app.fetch`.
 */
export default {
  // #315: everything that is not the host — api.proappstore.online's own route, other service bindings, SELF —
  // arrives here, so a caller's X-PAS-App / X-PAS-Host never reach a route. Only HostApi above keeps them.
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(withoutHostContext(request), env, ctx),
  // #257: pas-app-events (deliver to the app worker, retry) and pas-app-events-dlq (fail the row). ctx carries exports.AppWorkerApi, the PAS binding of invoked app workers (#254).
  queue: (batch: MessageBatch<AppEventMessage>, env: Env, ctx: ExecutionContext) => handleAppEventBatch(batch, env, ctx as AppWorkerExports),
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // #123 runs on the five-minute platform tick. It is durable and has no
    // backfill behaviour; a delayed/missed tick never turns into a burst.
    // Worker schedules are only claimed and queued here; the queue() consumer below runs them (#257).
    ctx.waitUntil(runScheduledActions({ env, now: event.scheduledTime ?? Date.now() }).catch((e) => console.error(`[schedule] executor failed: ${(e as Error).message}`)));
    // #355: broker delivery envelopes are intentionally short-lived. Sweep on
    // every five-minute tick before the less frequent maintenance work.
    ctx.waitUntil(cleanupRemoteAuthRequests(env, event.scheduledTime ?? Date.now()).catch((e) => console.error(`[broker] cleanup failed: ${(e as Error).message}`)));
    const tickAt = event.scheduledTime ?? Date.now();
    // #107/#389: alert evaluation runs on every five-minute tick at the tick's scheduled
    // time, over completed intervals only, catching up on late or missed ticks
    // (lib/error-alerts.ts). Failures here must not take the other checks down.
    // #391: stamp the evaluator's health either way, so a stalled or failing evaluator reads unknown/degraded, never healthy.
    ctx.waitUntil(evaluateErrorSpikes({ env, now: tickAt, scheduled: true }).then(
      () => recordHealth(env.DB, 'evaluator', '', true, null),
      (e) => { console.error(`[alert] evaluation failed: ${(e as Error).message}`); return recordHealth(env.DB, 'evaluator', '', false, 'evaluation_failed'); },
    ));
    // #395: reliability objectives (burn rates, outages, degraded telemetry) beside the
    // #107 alerts above, and the bounded retry of failed app.alert webhook deliveries.
    ctx.waitUntil(evaluateReliability({ env, now: tickAt }).catch((e) => console.error(`[reliability] evaluation failed: ${(e as Error).message}`)));
    ctx.waitUntil(retryDueDeliveries(env.DB, tickAt));
    // #456: a ProAgentStore verifier run whose agent has gone quiet runs headlessly instead.
    ctx.waitUntil(fallBackStalePagsRuns(env, tickAt).catch((e) => console.error(`[pags] timeout sweep failed: ${(e as Error).message}`)));
    // The pre-existing checks remain every fifteen minutes even though the
    // Worker now receives a five-minute tick for scheduled app actions.
    if (new Date(tickAt).getUTCMinutes() % 15 !== 0) return;
    ctx.waitUntil(checkSessionKeyDrift({ env }));
    // #381: the payout run (runScheduledPayouts) is archived in archived/payouts/ and no longer scheduled.
    // #275: close new app-worker enables when today's account-wide usage passes the ceiling.
    ctx.waitUntil(checkAccountCeiling(env, tickAt).catch((e) => console.error(`[app-worker-usage] account check failed: ${(e as Error).message}`)));
    // #307: once a day, delete review uploads older than the app's retention (default 30 days).
    if (new Date(tickAt).getUTCHours() === 3 && new Date(tickAt).getUTCMinutes() === 45) {
      ctx.waitUntil(reapReviewUploads(env, tickAt).catch((e) => console.error(`[review-retention] run failed: ${(e as Error).message}`)));
      // #374: provisioning plans are kept a day past expiry, then deleted.
      ctx.waitUntil(pruneProvisioningPlans(env.DB, tickAt).catch((e) => console.error(`[provisioning-plans] prune failed: ${(e as Error).message}`)));
      // #393: browser source maps past their 30-day window — bundle deleted, release kept as an `expired` tombstone.
      ctx.waitUntil(sweepSourceMaps(env, tickAt)
        .then((r) => console.log(`[sourcemaps] sweep expired=${r.expired} removed=${r.removed}`))
        .catch((e) => console.error(`[sourcemaps] sweep failed: ${(e as Error).message}`)));
    }
    // #381: the hourly payout-meter AI Gateway reconciliation (reconcileAiGateway) is archived and no longer scheduled.
  },
};
