# Operational Monitoring & Runbook

> **App requirements** for monitoring, log hygiene, rate limits and incident evidence are clauses in the [Application Standard — Operations chapter](./standard/ops.md) ([PAS-OPS-011](./standard/ops.md#pas-ops-011) – [015](./standard/ops.md#pas-ops-015)). This runbook is the platform procedure those clauses cite.

How to see, triage, and act on app/runtime failures across the PAS Workers
control plane (backend `api`, `host`, per-app `data-*`, `qa-worker`,
`agent-teams`). Tracks issue #107.

## Signals — where failures show up

| Signal | Source | How to read |
|---|---|---|
| **Client runtime errors + failed ops** | `app_logs` (SDK `app.logs`, #105/#106) | `GET /v1/apps/:appId/logs?level=error&since=<ms>` (owner) or the dashboard |
| **Usage drop** (proxy for outage) | `usage_daily` | `GET /v1/apps/:appId/usage` — a sudden drop can mean the app is broken |
| **Visitor analytics / diagnostics** | Workers Analytics Engine | `GET /v1/apps/:appId/analytics` |
| **QA flow failures** | `app_test_flows` / runs | `qa_list_runs` MCP tool / `GET .../qa/runs` |
| **Worker exceptions (5xx)** | Cloudflare Workers logs | `wrangler tail proappstore-api` (and `-host`, `pas-data-<app>`) |
| **Data-worker 5xx** (#394) | `app_logs` `source = 'server'`: category `action` (through the API) or `db` with `data.route = 'platform.data'` (browser `app.db`, reported by the host) | `GET /v1/apps/:appId/logs?source=server` or the incident lookup below; still in `wrangler tail pas-data-<app>` with the trace id |
| **One incident, every hop** (#394) | `app_logs` rows sharing a trace id + the `app_worker_invocations` row of that id | `GET /v1/apps/:appId/incidents/:traceId` (owner) |
| **Agent build/deploy failures** | agent-teams activity log | `agent_activity` MCP tool |
| **Alerts** (spikes detected from the incident counters, #391) | `app_alerts` (#107) | `GET /v1/apps/:appId/alerts` (owner) — the console's per-app workspace; `open=1` for unacknowledged |
| **Telemetry health + counts** (#391) | `telemetry_health`, `app_metric_buckets`, AE `pas_app_requests` | `GET /v1/apps/:appId/telemetry/health` (owner) — `ok` / `degraded` / `unknown`, failure counts, request totals and latency |

## Triage: "an app is failing"

1. **Scope it.** `GET /v1/apps/:appId/logs?level=error&since=<last 1h>` — cluster
   by `category` (`runtime`, `unhandledrejection`, `action`) and `message`. The
   `data.route`, `data.status`, `data.action`, and `build` fields localise it.
2. **Is it the app or the platform?** `action`/`status:5xx` entries → platform
   (backend/data-worker) — `wrangler tail proappstore-api` / `pas-data-<app>`.
   `runtime`/`unhandledrejection` → app client code — check the `build`/`route`.
3. **Blast radius.** One user (their `user_id` only) vs many (all users on a
   route) vs all apps (platform-wide → check `wrangler tail` for the shared
   Worker). Cross-check `usage_daily` for a correlated drop.
4. **Recent change?** Compare the failing entries' `build` metadata to the last
   green deploy; a spike right after a deploy points at the diff.

## Creator Console Logs: session-loss investigations

The selected app's **Logs** workspace is owner-only. It reads
`GET /v1/apps/:appId/logs` with the creator session in an HTTP header; the
Console never puts a session credential in a URL. Use the time range, level,
category, `phase`, anonymous `client_id`, fingerprint, source, and trace filters
to narrow an incident. Pages are bounded to 100 records and use the returned
cursor for older records.

For the session-loss diagnostics introduced in #353, start with
`category=auth.session_lost` and copy its trace/correlation ID into the trace
filter. The host persists the same anonymous correlation ID before it clears an
API-plane cookie, so the server event remains queryable even if the browser
cannot upload its best-effort diagnostic. A transient
hydration failure is `auth.hydration_failure`; it is evidence that validity was
unresolved, not proof that the user was signed out. Data-plane 401s do not create
session-loss events.

The Logs view intentionally renders only the reviewed columns and never renders
the arbitrary `data` envelope. Ingestion bounds and sanitizes telemetry; the
Console additionally redacts credential-shaped text, cookies/authorization
headers, URLs with query strings, and email-shaped text as defence in depth.
Do not use logs to store request payloads, child/student data, cookies, tokens,
or authentication headers.

## Thresholds (starting points; tune per app)

- **Error rate:** > 5% of a route's sessions logging `level:error` in 15 min.
- **Action failures:** any single `action` failing > 20 times / 5 min for one app.
- **5xx:** any sustained backend/data-worker 5xx (not a one-off).
- **QA:** 2+ consecutive failed post-deploy QA runs for an app.

## Remediation quick links
- Data-worker signing-key drift / 401 cascade → run the **Redeploy data workers**
  workflow (`redeploy-data-workers.yml`). See [migration-repair-runbook](./migration-repair-runbook.md).
- Schema drift (`no such column`) → `GET /v1/apps/:app/schema-status` / re-deploy
  (migrations apply before registration).
- Compliance/provision failure on publish → check the app's Deploy-to-R2 run.

## Troubleshooting: private-app e2e results not appearing

After a green deploy, agent-teams harvests `kb.proappstore.online/<app>/.e2e/summary.json`
into the console Test tab over the `KB` service binding, sending `x-internal-token`.
The KB host answers a private app's KB only to a matching `INTERNAL_TOKEN` (#277);
any other caller gets a plain 404, the same as "no tests yet". Since #303 M5 the
two sides log the difference:

- **agent-teams** activity log (`agent_activity`) and Workers logs. Each line
  names the app, commit and ticket (`slug: …, sha: …, ticket: …`), never a token
  or a response body. `harvestTestResults` returns the outcome (#371):

  | Outcome | Log line | Meaning |
  |---|---|---|
  | `auth_failure` | `Private-app harvest authorization failure: HTTP <401/403/404> from KB host (…) — check INTERNAL_TOKEN on proappstore-kb-host` | The private KB refused agent-teams; a 401/403 for a public app reads `KB harvest authorization failure`. |
  | `failed` | `Test harvest failed: HTTP <status> from KB host (…)` or `Test harvest error (…): …` | Any other non-OK answer (5xx, 429, …) or an error. Usually transient; the next deploy retries. |
  | `no_summary` | `No e2e summary yet (…)` | A public app with no published summary yet. Expected. |
  | `skipped` | `Private-app harvest skipped: INTERNAL_TOKEN is not set on proappstore-agent-teams (…)` | The caller side is missing the token. |
  | `harvested` | `Test results harvested: <n> passed, <m> failed` | Normal. |

- **kb-host** Workers logs (`wrangler tail proappstore-kb-host`):
  `KB private gate: token mismatch for <app> (server token configured: <bool>)`.
  `false` means the secret is missing on the KB host; `true` means the two
  workers hold different values.

Fix: `INTERNAL_TOKEN` on `proappstore-kb-host` must equal the value agent-teams
holds. `wrangler secret list --name proappstore-kb-host` shows whether it is set
(names only). Setting it is a credential-holder step: pipe the value from the
secrets store (`wrangler secret put INTERNAL_TOKEN --name proappstore-kb-host`),
never type or paste it, and keep the inventory's `consumers:` in step.

## Alerts (automated — #107)

The backend cron (`*/5`, `index.ts` `scheduled`) runs `lib/error-alerts.ts`
`evaluateErrorSpikes` on every five-minute tick, at the tick's scheduled time.
It evaluates **completed** intervals only — never one that ends after the
tick — and records one `app_alerts` row per app, kind and interval: 15-minute
windows for error spikes, 5xx and QA, 5-minute slices for action failures.

- **Idempotent.** Each tick re-evaluates every interval that ended in the last
  30 minutes (`CATCH_UP_MS`). The unique `(app_id, kind, window_start)` index
  turns the repeats into one row and one webhook delivery per interval.
- **Late or missed ticks** are caught up within those 30 minutes. An interval
  that ended more than 30 minutes before the next tick that runs is not
  evaluated: an outage of the cron is a gap in alerting, not a burst of stale
  alerts. Check the period by hand (`GET /v1/apps/:appId/logs`) after one.
- **On demand** (`POST /v1/apps/:appId/alerts/evaluate`) evaluates the same
  completed intervals for one app; the interval in progress is not included.

Kinds and the implemented thresholds:

Since #391 the counts come from the incident counters (`app_metric_buckets`,
below), which every recorder writes **before** its detail budget, so a day
whose detail rows were throttled still alerts on what happened.

| Kind | Counter signal | Fires when |
|---|---|---|
| `error_spike` | `client_error` (client-reported `error` entries) | ≥ 20 in the 15-minute window **and** ≥ 3× the previous window |
| `action_failures` | `action_failure` (server-observed failed actions, any status) | ≥ 20 in one completed 5-minute slice (the "> 20 / 5 min" rule above); a burst that straddles a slice boundary is counted per slice |
| `server_5xx` | `server_5xx` (API 5xx with a `platform`/`unknown` verdict, host-reported data-plane 5xx) | ≥ 5 in the window ("sustained") |
| `qa_failures` | `app_test_runs`, deploy/cron triggers | ≥ 2 consecutive failed runs with no pass since, raised in the window holding the latest failure (the "2+ consecutive" rule; live now that #62 fixed stuck runs) |
| `scheduled_action_failures` | scheduled registered-action runs | 5 consecutive failures disable that action until its manifest is re-registered; inspect `GET /v1/apps/:appId/scheduled-runs` or MCP `list_scheduled_runs` |

The runbook's "5% of a route's sessions" is not computed yet (it needs session
counts joined to routes); the absolute-plus-jump rule above is the starting
point — tune the constants at the top of `lib/error-alerts.ts`.

**Payload** (`GET /v1/apps/:appId/alerts`): app id, kind, window, count (from
the counters), the previous window's baseline, and — marked
`detail_basis: "retained_rows_sample"` — affected users (distinct sessions or
anonymous client ids **among retained detail rows**: a lower bound, never an
exact affected-user count; 0 when every row was withheld), top categories /
operations / fingerprints, and the latest build metadata seen in the window. Never a log message, request body,
token, credential or user id.

**Where it goes**: the console (pull — ADR-008 decision 6). Owners who want a
push receive the same payload on a registered webhook for event `app.alert`
(`POST /v1/apps/:appId/webhooks`, HMAC-signed by `lib/webhook-dispatch.ts`);
nothing is sent unless one exists. `POST /v1/apps/:appId/alerts/evaluate` runs
the evaluation for one app on demand; `POST …/alerts/:id/ack` acknowledges.
Every recorded alert is also a `[alert] …` line in Workers Logs.

**Not automated**: the "5% of sessions" rate; cross-app platform-wide spikes
(each alert is per app). Data-worker 5xx with a `platform` or `unknown` fault
verdict are `error` rows and so count towards `server_5xx` (#394); `tenant` and
`client` faults are `warn` rows and do not.

## Following an incident across hops (#394)

A request can cross four hops: browser → host → API → data worker (or app
worker). They share one W3C trace id:

- The SDK sends a `traceparent` (#390). The host forwards a valid one unchanged
  and **mints one when the page sent none or a malformed one**, so every hop past
  the host carries a trace. It never authorizes on it.
- The API keeps the trace, takes its own span, and sends
  `traceparent: 00-<trace>-<api span>-00` to the data worker on action calls.
  Every error answer names the trace in `traceId` / `X-PAS-Trace-Id`.
- The data worker logs `Unhandled error: { traceId, route, fault }` (route
  pattern, never the URL or SQL) and answers its 500 with `X-PAS-Fault`.

**Where each hop's evidence lands**

| Hop | Evidence | `hop` in the lookup |
|---|---|---|
| Browser | SDK rows (`source` `mediated` / `direct`), best-effort | `browser` |
| Host | session-loss rows (`auth.session_lost`, #353); `[pas-data-plane-failure]` in host Workers Logs | `host` |
| API | operation-failure rows (`source = 'server'`), span and parent span in `context` | `api` |
| Data worker | via API: the action row with `data.fault`; via the browser data plane: a `db` row the host reported over HostApi (`POST /v1/internal/data-plane-failures`, HostApi-only like session invalidations) | `api` / `data-worker` |
| App worker | `worker-console` rows and the invocation's CPU/wall/outcome (#308), keyed by the invocation id | `app-worker` |

**Fault attribution.** The data worker's verdict decides whether a 5xx is the
platform's: `platform` (D1 unavailable/overloaded/reset, or a bug — the default)
and `unknown` (a data worker deployed before #394, which sends no verdict) are
`error` rows and count as platform 5xx; `tenant` (SQLite rejected the app's own
SQL: no such column, constraint failed, syntax error, …) and `client` (a body
that is not JSON) are `warn` rows. Analytics Engine (`pas_app_errors`) carries
the verdict as the last blob of each point, so a shared platform outage reads as
`platform` faults across many app indexes at once, and an app's own bad SQL
never does.

**Lookup.** `GET /v1/apps/:appId/incidents/:traceId` — owner-only, `no-store`,
every query scoped to `:appId`, so owner A cannot read app B's rows even with
B's id. It returns the app's rows for the id oldest first (at most 200, with
`truncated`), a `hops` count, and the app-worker invocation of that id. The id
may be a W3C trace id, a #353 session-loss correlation id or a #308 invocation
id: the lookup is by stored value, so old ids keep working. Rows never carry a
request URL, SQL, body, cookie or authorization header; the data-plane report
sends only status, verdict, endpoint name (`query`, `execute`, … else `other`),
the trace and `cf-ray`.

**Missing hops are gaps, not all-clears.** A hop that succeeded writes no row;
browser rows are best-effort and may never arrive; detail rows are budgeted per
app per day (`SERVER_FAILURE_DAILY_LIMIT`, #372) and dropped over it; and a data
worker not yet redeployed sends no verdict. The lookup shows what was recorded.

**Sampling and retention.** Cloudflare Workers traces are on for `proappstore-api`,
`proappstore-host` (wrangler.toml) and every data worker (upload metadata in
`lib/deploy-worker.ts`), **head-sampled at 10%** and kept 7 days by Cloudflare,
with no external exporter. Head sampling means **most failures have no retained
span**, and nothing here claims otherwise. It does not affect failure counting:
Analytics Engine points and `app_logs` rows are written for every failure
before any detail budget is checked, and Workers Logs stay at 100%. Spans are a
dashboard aid; the trace id in headers and rows is what finds an incident.
`app_logs` retention is the logs-prune schedule, not Cloudflare's.

**Rollout.** The backend and host settings apply on their next deploy. A NEW
data worker gets the trace settings and the fault verdict at provision. An
EXISTING one keeps its old bundle and settings until it is re-uploaded by the
**Redeploy data workers** workflow (`redeploy-data-workers.yml`, one app or the
fleet); until then its 5xx are recorded with fault `unknown`.

**Aggregates (#391).** Both recorders above — `recordOperationFailure`
(API-observed, with `fault`) and `recordDataPlaneFailure` (host-observed) — add
to the incident counters below before their detail budget: `platform`/`unknown`
faults as `server_5xx`, `tenant`/`client` as `tenant_fault`/`client_fault`.

## Incident counters and telemetry health (#391)

Detail rows (`app_logs`) are budgeted — client entries 50,000 per app per day
plus a per-key burst limit, server failure rows 10,000 per app per day (#372) —
so counting rows undercounts an app when it is failing hardest. Counts that
alerts and the health API rely on are kept separately.

**Incident counters — `app_metric_buckets` (D1).** One row per app, 5-minute
bucket and signal; signals are a fixed set (`lib/metric-aggregates.ts`), so
cardinality is apps × buckets × signals and never user, trace, game or path:

| Signal | Written by | Trust |
|---|---|---|
| `client_error`, `detail_dropped_client` | `POST /v1/apps/:appId/logs` (every batch, persisted or not) | untrusted: public ingestion can only ever add `client_*` |
| `action_failure`, `server_5xx`, `tenant_fault`, `client_fault`, `detail_dropped_server` | the API's operation-failure hook; the host's HostApi data-plane report | trusted: past the #375 gate (app exists; below 5xx the caller must belong to it). An anonymous 5xx is counted (a server status cannot be forged) but still writes no row |

Every write is one D1 batch per failure or ingested batch, never per request.
Counters are pruned with app logs (30 days, `/internal/logs/prune`).

**Request denominators and latency — AE `pas_app_requests`.** One point per
app-scoped API request (`/v1/apps/:appId/…`): outcome class (`ok` / `4xx` /
`5xx`) and latency bucket (`lt_100ms` / `lt_500ms` / `lt_2s` / `ge_2s`), with the
exact latency as a double. No route, user or trace. Excluded: the telemetry
plane itself (`logs`, `incidents`, `telemetry`, `alerts`), CORS preflights,
WebSocket upgrades, and ids that are not app slugs. In Analytics Engine, not
D1, so no API request waits on or writes to the platform database for it.
Analytics Engine **samples**: totals are weighted by `_sample_interval`, so
they are estimates, and AE data can lag by minutes. The 5xx rate is
`5xx / (ok + 4xx + 5xx)` from the same points; it is `null`, not 0, when
nothing was counted. These request 5xx include every app-scoped API 5xx; the
`server_5xx` counter excludes tenant/client faults — compare like with like.

**Pipeline health — `telemetry_health` (D1).** Each component stamps its last
success and last failure:

| Component | Stamped by | Stale after |
|---|---|---|
| `evaluator` (platform) | the five-minute cron, success or failure | 15 minutes (three missed ticks) |
| `prune` (platform) | `/internal/logs/prune` (daily, `prune-app-logs.yml`); a partial run is a failure | 2 days |
| `aggregates` (per app) | every counter write; a failed write stamps a failure when D1 accepts it | never (a quiet app writes nothing): `no_data` until its first write |

A component is `degraded` when its latest attempt failed, `unknown` when it has
never succeeded or its last success is stale, `ok` otherwise; the next success
clears `degraded`.

**`GET /v1/apps/:appId/telemetry/health`** (owner-only, `no-store`):

- `status`: `unknown` when the evaluator is unknown; `degraded` when any
  component is degraded or AE request data cannot be read; else `ok`.
- `countsReliable`: false when the evaluator is unknown — a zero then means
  "cannot tell", not "none". With `status: ok`, zero is zero.
- `windows.lastHour` / `lastDay`: per-signal counter sums and detail-dropped
  counts (the current 5-minute bucket is partial).
- `requests`: weighted AE totals, 5xx rate and latency histogram for the last
  hour and day, `sampled: true`; `status: unknown`, `reason:
  analytics_unavailable` and null windows when AE cannot be read (missing
  `CF_ANALYTICS_API_TOKEN`, an AE outage) — never zeros.

Analytics Engine is not on the alerting path: an AE outage degrades the request
denominators and the `pas_app_errors` points, not alerts.

**Deploy note.** The counters start empty when migration 0100 is applied: an
alert window that straddles that deploy counts only failures recorded after it,
so a spike already under way can be undercounted for up to 30 minutes.

## Visitor analytics on app origins (#402)

Visitor analytics (pageviews and `window.pasAnalytics.event()` custom events,
the `pas_analytics` AE dataset) is separate from `app.logs` diagnostics. An app
embeds `<script src="https://api.proappstore.online/v1/analytics.js?app=<id>">`.

- **On an app origin** (`<id>.proappstore.online`, a custom apex, a tenant
  domain) the host rewrites that tag to `/.pas/analytics.js`, and the loader it
  serves posts to `/.pas/analytics/event` on the same origin. An app whose own
  meta CSP is `connect-src 'self'` therefore needs no change and no CSP
  exception. Signed-out visitors count; no cookie or credential is forwarded.
  - The app is the **resolved route's**, sent to the API as `X-PAS-App` over
    HostApi; a body's `app` is ignored, so one app's page cannot post as another.
  - The event endpoint takes `POST` from the same origin only (`Origin`, else
    `Sec-Fetch-Site`), bodies up to 64 KB, to one fixed upstream path.
  - Private apps: the private-app gate runs first, so only admitted users count.
- **On any other site** the loader and `POST /v1/analytics/event` on the API are
  unchanged: the event names its app in the body (unverified, as before).
- The loader sends an event once: a queued beacon is never also fetched or
  buffered, the offline outbox deletes only what a drain delivered, and a
  pageview is a change of path (same-path `replaceState`, query and hash
  changes are not new pages).

Check: in the browser console of the app, no CSP violation for
`/.pas/analytics/event`; the Network tab shows the beacon `POST` with 204.
