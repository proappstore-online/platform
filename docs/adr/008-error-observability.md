# ADR-008: Error observability — CF-native server capture, Analytics Engine for signal, bounded D1 for detail, BYO tracker for creators

## Status

**Proposed** (2026-07-30). Written to unblock platform#105, #106, #107, #108 and
proappstore-online/console#1, which together propose turning on automatic error
capture but do not decide *where error data lives* or *what we build vs. adopt*.
Refs ADR-001 (Workers-only) and ADR-003, whose known-limitation §"Cross-Worker
observability is split across three log streams" this ADR closes for the server
side.

## Date

2026-07-30

## Context

`app_logs` (migrations/0015) and `POST /v1/apps/:appId/logs` have existed, unused,
since the FAS vendoring. #105/#106 propose an SDK logger that writes to them
automatically; #107 proposes alerting on the result; #108 proposes hardening
ingestion first. Read together, the default reading of those four issues is "one
D1 `INSERT` per browser error, forever, in the shared `pas` database, gated on a
session." Four facts make that the wrong default:

1. **Signed-out errors are unloggable.** `app_logs.user_id` is `NOT NULL` and
   ingestion runs `requireUser` (logs.ts:24). The motivating failures — white
   screen on load, sign-in itself broken, the #89 credential-lockout path —
   produce no row. A failed `signInWithCredentials` has no session *by
   definition*, so it can never reach an auth-gated sink.
2. **Nothing prunes `app_logs`.** No retention, no pruning cron; the backend Worker
   has no cron trigger at all. `pas` is a single shared D1 (10 GB ceiling) holding
   every app's rows.
3. **Caps are per-request only** (`MAX_BATCH_SIZE=100`, `MAX_ENTRY_SIZE=4096`). One
   app in a render-error loop self-floods. No attacker required.
4. **We already own the right primitives and have not turned them on.** The
   `ANALYTICS` Analytics Engine dataset is bound (backend/wrangler.toml:42) and
   already queried per-app via `cfAnalyticsSql`. `POST /analytics/event`
   (analytics-ingest.ts:83) already accepts unauthenticated, batched, per-(app,
   IP, kind)-sampled client events. Meanwhile **no** wrangler.toml in the repo
   sets `[observability]`, declares `tail_consumers`, or enables
   `upload_source_maps` — the platform-native answers to ADR-003's complaint are
   simply off.

There is also a scope question the issues do not raise. PAS hosts **third-party
creator apps**, including a children's app with provisioned student credentials.
Becoming the APM vendor for every creator app is a product commitment (cost,
retention, PII custody, support) distinct from "the platform can answer a support
question."

## Decision

Five decisions, in dependency order.

### 1. Turn on CF-native server-side observability before writing any code

- `[observability] enabled = true` on every Worker (backend, host, data-worker
  template, admin, agent-teams, qa-worker, kb-host) — queryable Workers Logs,
  days-scale retention (7d at time of writing), head-based sampling available.
- One **Tail Worker** (`tail_consumers`) consuming all producer Workers. A Tail
  Worker receives `console.*` output *and uncaught exceptions plus the request
  `outcome`* — which is precisely the "three split log streams" ADR-003 flagged,
  in one place, with no per-route instrumentation.
- `upload_source_maps = true` so Worker stack traces de-minify.

This is configuration, not architecture. It covers #107's "backend/data-worker
5xx" ask with no custom counters. The one line of instrumentation still worth
adding is in `app.onError` (backend/src/index.ts:96), which today only
`console.error`s: emit one AE data point so 5xx rate is *queryable* as a metric
rather than only greppable as a log.

**`upload_source_maps` is Worker-side only.** It does nothing for browser app
code, which ships as static assets to R2 via each app's GitHub Actions. Browser
symbolication is deliberately out of scope for the first slice; see
Consequences.

### 2. Two-tier client error storage — AE for signal, bounded D1 for detail

| | Analytics Engine (`ANALYTICS`) | D1 `app_logs` |
|---|---|---|
| Holds | counts, rates, spikes | recent detailed events |
| Auth | **anonymous allowed** | session or anonymous client id |
| Volume | unbounded, sampled (`_sample_interval`) | bounded ring, TTL-pruned |
| Retention | 90 days (already relied on by the diagnostics query) | 7–30 days, cron-pruned |
| Feeds | #107 alerting, console summary cards | console#1 detail table, support drill-down |
| Not for | stack traces (1 index ≤96 B, ~5 KB total blobs, sampled) | high-volume counting |

Every captured error writes one AE data point. Only a **rate-limited subset**
writes a D1 row. This resolves anonymous coverage, cost, and retention together:
counting is cheap and complete; detail is bounded and best-effort.

### 3. Adopt existing standards for the data model — invent nothing

The one genuinely new schema in this design is grouping, and even that is a
well-known shape.

- **Fingerprint/grouping is mandatory, not a later nicety.** `app_logs` is
  flat: no `fingerprint`, no group. Every real error tracker (Sentry, Bugsnag,
  Rollbar, Honeybadger) groups occurrences into an *issue* with count, first/last
  seen, and affected-user count, because that is the unit humans and alerts
  reason about. Without it, console#1's "recent logs table" is a firehose and
  #107 can only say "400 errors," never "*this* error, 400 times, 12 users, since
  the 14:02 deploy." Add `fingerprint TEXT` (stable hash of normalized
  type + top frames) plus an `error_groups` rollup.
- **Field names follow OpenTelemetry log/exception conventions** —
  `exception.type`, `exception.message`, `exception.stacktrace`,
  `service.version`, `trace_id`, `span_id` — rather than new spellings of
  `category`/`data`. Free at schema-design time, expensive to retrofit, and it
  keeps a future OTel/Logpush export a mapping rather than a migration.
- **Correlation uses W3C `traceparent`, not a bespoke `X-Request-Id`.** #106 asks
  for a correlation id "if the backend can emit one." The right one is the
  standard: the SDK generates `traceparent`, the backend propagates it to the
  data-worker, all three log the same `trace_id`. That is what makes the
  browser → backend → data-worker hop reconstructable — the exact split ADR-003
  named. Note `cf-ray` already identifies each *edge* hop for free and should be
  logged alongside, but it does not survive the subrequest, so it is not a
  substitute.
- **Anonymous capture:** make `user_id` nullable and add a rotating
  `client_id` (per install, not per person). Standard practice, and the only way
  decision 2's anonymous tier works.

### 4. Ingestion limits use the Workers rate-limiting binding, plus a D1 rollup

Do not hand-roll a counter. Use the native Workers rate-limiting binding
(`[[unsafe.bindings]]`, `type = "ratelimit"`) keyed on `app_id` and on
`client_id`. Caveat that shapes the design: its `period` is restricted to 10 or
60 seconds, so it handles **bursts** only. Per-app *daily* quota (a
Sentry-style "spike protection" cap, after which we keep counting in AE and stop
writing D1 rows) needs a small D1/DO rollup on top. The in-isolate sampling
bucket at analytics-ingest.ts:66-80 is the cheapest interim pattern and is
already proven in this codebase.

**Correction to an earlier draft of this ADR:** it claimed the backend had no
rate-limiting primitive. It has three — `lib/rate-limit.ts` (in-isolate,
per-second), `lib/proxy-rate-limit.ts` (durable per-app/day, probabilistic
writes), and `lib/credential-rate-limit.ts`. The gap is narrower than stated: a
*durable per-app/day counter for logs*, which `lib/log-quota.ts` now builds by
composing the first two rather than inventing a third. Any future work here
should extend those, and platform#83 (provisioning abuse controls) should do the
same.

One invariant, learned the hard way: **the burst ceiling must stay at or above
`MAX_BATCH_SIZE`.** Set below it, a single legal full batch is throttled on
arrival and no app can ever flush one. There is a test asserting the ordering.

**App-context binding is real work, not a URL change.** #108 proposes preferring
the mediated `/.pas/api/.../logs` route "so the host can bind the log to the app
context." Today it cannot: `platform-mediation.ts:11-14` is a blanket
path-rewriting proxy that forwards `/.pas/api/v1/apps/<anything>/logs`
unchanged. (Contrast the *data* plane at line 35, which derives its upstream from
`route.slug`.) To make the claim true, mediation must inject a trusted
`X-PAS-App: <route.slug>` header — stripping any client-supplied copy exactly as
it already strips `X-Internal-Token` (line 76) — and the backend must reject a
mismatch against the path `appId`.

**Scrubbing is server-side as well as client-side.** #105/#106 specify client
redaction only. Deployed app versions cannot be trusted or updated on demand, so
the ingest endpoint also denylists credential/token/cookie-shaped fields. Defense
in depth, and it is the only layer we control after an app ships.

### 5. Creators get a BYO error tracker; the platform does not become their APM

Add an optional per-app Sentry DSN (or generic webhook), stored and injected the
same way `ga4` / `plausible` / `custom_head` already are in `app_analytics`
(analytics.ts:67-79). Platform capture stays deliberately shallow — enough to
answer "did this user hit an error, on which action, on which build" — and any
creator wanting breadcrumbs, releases, session replay, and full symbolication
points their own tracker at it.

This mirrors an established convention in this codebase rather than adding one,
and it caps our scope: we own the support signal, not the APM product.

### 6. Alerts surface in the console only — no external delivery

#107 leaves "decide where alerts go: email, webhook, console notification, or
GitHub issue/comment" open. **Decided: console surface only, for now.** Error
spikes and group summaries render in the per-app workspace (console#1); nothing
is emailed, pushed, or POSTed anywhere.

Rationale: an alert channel is only worth wiring once someone is on the hook for
responding to it, and pre-launch there are no production users generating the
volume that makes polling insufficient. Console-only also keeps this whole design
**inside Cloudflare with zero data egress** — see below.

Every external channel is already integrated in this repo and stays available
without new infrastructure when we want it: Resend (`email.ts:19`), Web Push
(`notifications.ts` via `web-push`), a generic webhook dispatcher
(`lib/webhook-dispatch.ts`, which is the right seam for Slack/Discord later), and
GitHub. Deferring costs nothing; adding a channel later is a config change, not a
redesign. **When we do add one, route it through `dispatchWebhook`** rather than
calling a provider directly, so the choice of destination stays an operator
setting.

Consequence to accept honestly: console-only means **alerts are pull, not push** —
nobody is notified, someone has to look. That is acceptable pre-launch and is
*not* acceptable once real users depend on these apps. Revisit at launch.

### Third-party surface: none

With decision 6, the design is entirely Cloudflare-native and adds no
dependencies:

- **CF primitives:** Workers Logs, Tail Worker, `upload_source_maps`, Analytics
  Engine (bound already; read via CF's own Analytics SQL API), D1, the Workers
  ratelimit binding, cron triggers, R2 (sourcemap follow-up).
- **No new npm dependencies.** Fingerprinting is a hash function we write.
- **OTel conventions and W3C `traceparent` are specifications, not tools** — field
  names and a header format. They add no SDK, no collector, no exporter. Adopting
  the *conventions* is explicitly not adopting the OTel *stack*; a real OTel
  export would mean Logpush to a third-party sink, which is out of scope here.
- **The only third party is the opt-in per-app BYO tracker (decision 5)** — a
  creator's own account, their own app's data, off by default, and no platform
  egress if nobody opts in.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| **Sentry SaaS as the primary sink for all apps** | Best-in-class at exactly #105/#106/#107, and we should not reimplement its *concepts* — hence decision 3. But as the primary sink it fails on three platform-specific counts: it is a third-party sub-processor for a children's app's error payloads (GDPR/COPPA custody we currently keep first-party); its project-per-app model and per-event pricing scale badly across N creator apps we do not control the error volume of; and owner-scoped read access would have to be brokered by us anyway. Offered as opt-in BYO instead (decision 5). |
| **Self-hosted Sentry / GlitchTip** | Violates ADR-001 (Workers-only, no servers to run). Postgres + workers + storage is a larger operational commitment than the problem justifies. |
| **D1-only (the issues' implied default)** | No anonymous tier, unbounded growth in a shared 10 GB DB with no pruning, and one INSERT per error makes an error loop a cost incident. |
| **Analytics Engine only** | Sampled and capped (1 index ≤96 B, ~5 KB blobs) — fine for counting, cannot hold a stack trace or answer "show me this user's error." |
| **Workers Logs / Tail Worker only** | Adopted for the *server* side (decision 1), but days-scale retention and no per-app owner-scoped read make it unfit as the app-facing error store creators query from the console. |
| **Custom `X-Request-Id` correlation** | `traceparent` is the standard, already understood by every downstream tool, and survives the backend → data-worker hop. No reason to spell it ourselves. |
| **External alert delivery now (email / push / Slack / GitHub issue)** | Deferred, not rejected (decision 6). No production users yet, so nothing justifies a push channel nobody is on the hook to answer; console-only keeps the design egress-free. All four channels are already wired and can be enabled later via `dispatchWebhook` without redesign. |

## Consequences

**Positive:**

- Anonymous and pre-auth failures — the ones that motivated #105 — become
  visible, which the issues as written could not do.
- Server-side observability lands as configuration in the first slice, closing
  ADR-003's known limitation without per-route instrumentation.
- Cost is bounded by construction: counting is sampled and cheap, detail is a
  capped ring, and a runaway app degrades to counters instead of a D1 bill.
- Alerting evaluates aggregated AE metrics rather than scanning raw rows on a
  cron — the standard shape, and it keeps #107 cheap.
- `traceparent` + fingerprints make "this error, this many users, since this
  deploy" answerable, which is the actual support question.
- One rate-limit primitive serves #108 and #83.

**Negative:**

- Two sinks is more moving parts than one table, and a reader must know which
  answers which question. Mitigated by the console being the only intended
  reader.
- **Browser stack traces will be minified** in the first slice, since
  `upload_source_maps` covers Worker code only and app assets ship via each app's
  own CI. Accepted knowingly: fingerprinting still groups reliably on normalized
  minified frames, and `build_meta` identifies the deploy. The follow-up is
  sourcemaps to an unlisted R2 prefix at publish time plus read-time
  symbolication in the console — a separate issue, not a blocker.
- The AE tier cannot be deleted per-user, so it must hold no PII beyond
  `client_id`. That is a hard constraint on what the SDK may put in AE blobs.
- Console-only alerting is **pull, not push**: an error spike is visible but
  nobody is told. Fine pre-launch, must be revisited at launch (decision 6).

**Neutral:**

- `app_logs` keeps its name and its owner-only read path; the schema gains
  `fingerprint`, a nullable `user_id`, and `client_id`. FAS vendored the same
  table, so this is a divergence between FAS and PAS unless ported — consistent
  with the workspace's vendor-don't-depend convention, and a PR port is the
  expected propagation path.
- Per-app BYO Sentry means some creators' error data leaves the platform. That is
  their call to make about their own app, as it already is for GA4.

## Implementation Sequence

1. **Config-only, no dependencies:** `[observability]`, Tail Worker,
   `upload_source_maps`, one AE data point in `app.onError`. Plus #107's runbook,
   which is doc-only and needs nothing else.
2. **#108** — mediation `X-PAS-App` binding, server-side scrubbing, `app_logs`
   schema migration, quota, and retention. **Done.** Retention follows the
   existing payout-cron convention (internal endpoint + scheduled workflow)
   rather than a Worker cron trigger: the backend's default export is a plain
   Hono app that service-binding callers and every route test depend on, and
   adding `[triggers]` would mean restructuring it. Trade-off accepted: pruning
   now depends on an external scheduler, so the endpoint reports a backlog and
   the workflow escalates it to a failure instead of exiting clean.
3. **Server-side action/auth failure logging** — the majority of #106's value.
   **Done.** Implemented as a single hook in `app.onError` rather than per-route
   instrumentation: every app-scoped failure already passes through there with
   the route pattern, status and `:appId` resolved, so one hook covers actions,
   db, rooms, invites, roles and storage at once and does not drift as routes are
   added. Credential flows are instrumented explicitly, since their `appId`
   arrives in the body rather than the path.

   Two constraints discovered while building it, both now enforced in code:
   - **Rows require an authenticated caller; counts do not.** `source = 'server'`
     is the tier an owner trusts most, so it must not be mintable — otherwise any
     caller could POST junk to `/v1/apps/<victim>/actions/x`, take the 400, and
     write a row into that app's log, reintroducing #108's cross-app spoofing
     through the trusted path.
   - **The log endpoints are excluded from operation logging.** A failed log
     upload writing a log row is circular, and it would let malformed bodies
     generate rows.
4. **SDK logger (#105)** reusing `usage.ts`'s transport (batch, `pagehide`,
   `sendBeacon`, mediated-URL and auth-mode handling at usage.ts:176-220) rather
   than a second implementation of it.
5. **#106 client residue** — failures that never reach the API.
6. **#107 alerting** off AE metrics, **rendered in the console only** — no
   external delivery (decision 6). Gate the QA-failure signal behind #62 (tail
   flows stuck in `running` would alert on a known-broken signal).
