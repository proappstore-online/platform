# ADR-009: App workers — platform-hosted, sandboxed per-app server code

## Status

**Accepted** (2026-10). Supersedes the option-1 rejection recorded in platform#147
("general per-app Worker cron: rejected for now"). Keeps the single control plane
described in [Architecture](../architecture.md) (originally ADR-003, since
superseded by that document): `proappstore-api` still owns identity, data, secrets
and scheduling; app workers are tenants of it, not a second control plane. Tracked
by platform#251.

## Date

2026-10-01

## Context

PAS apps are static SPAs whose server logic is SQL actions declared in `mcp.json`.
Scheduled actions (#123) run that SQL on a timer under `system:schedule`. That is
enough for maintenance; it is not enough for an app that must *call out* —
sync from GitHub, receive a third-party webhook, poll an external API — because no
app-authored code runs server-side, app secrets reach only the browser-session proxy,
and the only inbound webhook is the platform's own Stripe endpoint.

The workaround apps reached for is the worst of both worlds: doordrop replaced its
platform-managed `pas-data-doordrop` worker with its own via `wrangler deploy`. The
next fleet redeploy silently put the generic worker back (2026-07-22), and the app's
`/v1/*` API has 404'd since. Another (duperdash) runs entirely outside PAS with its
own Cloudflare token, KV namespace, cron and Access app.

#147 rejected per-app workers because apps had no worker to attach a trigger to and
because unattended app code needs a sandbox, limits and abuse controls. This ADR
supplies those, and so withdraws the rejection.

### Trust assumptions

This ADR's isolation argument holds only if **no app repo can reach a Cloudflare
credential**. Two facts bound it:

- **Anyone holding a Workers-edit API token on the PAS Cloudflare account *is* the
  platform.** They can redeploy any `pas-app-<id>` script keeping its secret
  bindings (`PAS_WORKER_TOKEN`, `PAS_EVENT_KEY`), rewrite any binding's `props`,
  or redeploy `proappstore-api` itself. Nothing in §2's authorisation rule, the
  shim or the envelope signature defends against that holder; the per-app token
  defends only against a holder of *another app's* code, not of the account.
- **Today that boundary does not hold** (#274, critical). All `proappstore-online`
  organisation Actions secrets have visibility `all` — including the
  account-wide `CLOUDFLARE_API_TOKEN`, `SESSION_SIGNING_KEY` and
  `INTERNAL_TOKEN` — so every public app repo's workflows can read them. And
  **every publisher can run a workflow**: publishing invites the publisher as a
  **push collaborator** on their app's org repo (`addCollaborator`,
  `packages/admin/src/publish.ts:~443-478`), and a push collaborator can commit
  a workflow with their own GitHub credentials. Repo-level copies widen it
  further: `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID` (the
  account's `pas-prd-r2` key, which can write every app's static site) sit in
  29 app repos, re-copied hourly by `reconcile-app-secrets.yml` (removal:
  #279), and `CLOUDFLARE_API_TOKEN` sits in 5. The MCP `write_file` route to a
  workflow (#280) is a second, narrower path; guarding it is defence in depth,
  not the control.

Therefore **#274 must be closed before `app_workers_enabled` is set for any app
in production.** #253's spike and implementation may proceed before then; no app
worker is enabled, on any backend, while a Cloudflare credential (R2 keys
included) is reachable from an app repo, as an org secret or a repo secret. Exit
criterion 3 (§6) is the measured form of this assumption.

## Decision

### 1. An app may own one *app worker*, deployed by the platform, whose code runs only behind a platform-owned entry point

- The bundle is built in the app repo (`worker/`) and uploaded **through the
  platform**, authenticated by GitHub Actions OIDC exactly like
  `deploy-credentials`, `tools/oidc` and `migrate/oidc`. **No app repo may reach
  a Cloudflare credential — org secrets included**: not a repo secret, not an
  organisation secret whose visibility includes the repo, not a token placed by
  hand. R2 access keys (`R2_*`) count as Cloudflare credentials (see Trust
  assumptions; measured by §6 criterion 3).
- The platform constructs the script metadata (bindings, compatibility date,
  limits) and the **entry point**. App code cannot add, remove or alter a
  binding, and it is never the script's `main_module`.
- **The entry point is a platform-owned shim.** The platform uploads its own
  `main_module` alongside the app's modules. The shim verifies the event
  envelope signature (§3) with a constant-time compare *before* it imports the
  app's handler; a request that fails verification gets `401` and no app code
  runs — not even module top-level code, because the app module is imported
  only after verification passes. App-side verification is therefore not
  something an app can forget or get wrong.
- Whether the script is reachable from the Internet at all depends on the
  backend (§5): a `loader` worker has no URL; an `account` script is on a
  public `workers.dev` hostname and is protected **only** by the shim. "Invoked
  only by the platform" is a property the shim enforces, not one the hostname
  provides.
- The app worker is a separate script from the data worker. Platform redeploys of
  `pas-data-<id>` never touch it, and it can never replace `pas-data-<id>`.

### 2. Sandbox contract

An app worker receives **exactly**:

| Binding | What it is |
|---|---|
| `PAS` | RPC binding to `proappstore-api`'s `AppWorkerApi` entrypoint, with platform-set `props: { appId }` |
| `PAS_WORKER_TOKEN` | per-app secret; **required** second factor on every `PAS` call |
| `PAS_EVENT_KEY` | per-app HMAC key; read by the platform shim to verify event envelopes on every backend. The app's handler does not need it, but **it can read it**: env is not private to the shim (on `account`, any module can `import { env } from "cloudflare:workers"`; on `loader`, env is part of the `WorkerCode` the app's modules run with). Because the key is per-app, reading it lets an app forge events **only to itself** — nothing it could not already do by calling its own handler |
| `APP_ID` | plain text |

It receives **no** D1, KV, R2, Durable Object, Queue or AI binding, and **no** app
secret as an environment variable. Data goes through `PAS.actions.*` (registered,
linted SQL — the same actions every other caller uses); secrets through
`PAS.secrets.get(name)`, which returns only secrets the manifest declares for the
worker; files through `PAS.storage.*`; logs through `PAS.log`.

- **System-only actions are unreachable over HTTP.** Each action declares who may
  call it — `callers: ("user" | "worker" | "hook")[]`, default `["user"]` (#254).
  An action whose `callers` lacks `"user"` is refused on the HTTP actions route,
  as scheduled actions already are, so a write meant only for the worker or a hook
  can never be called by a signed-in user.
- **Worker storage is its own namespace.** `PAS.storage.*` reads and writes
  `${appId}/_worker/<key>` — never a user's prefix `${appId}/${userId}/…` — so
  worker files never appear in, count against, or can be overwritten from a
  user's file list and quota (#254).

**Per-app token lifecycle.** `PAS_WORKER_TOKEN` is **minted by the platform at
the app worker's first deploy** and stored in D1 against the app in two forms:
`token_hash` (SHA-256), which is what every `PAS` call is verified against, and
the token **sealed** under `APP_SECRET_KEK` (`token_ct`, `token_dek`,
`token_iv`; the envelope encryption of `lib/encryption.ts`). The sealed copy is
needed because the `loader` backend has no secret binding: its `env` is built in
the `LOADER.get()` callback on every cold load, so the platform must recover the
plaintext there; it is also used to re-upload `account`/`dispatch` scripts. The
plaintext is never stored unsealed, logged or returned by any route.
**Rotation** mints a new token, moves the old hash to `prev_token_hash` with
`prev_token_until` set to the end of an overlap window, and writes the new hash
and sealed token; until `prev_token_until`, either hash authorises, so
in-flight invocations holding the old token are not dropped. The `prev_*`
columns are cleared once the window has passed. **`AppWorkerHost.remove(appId)`**
(§5) clears `token_hash`, `prev_token_hash` and the sealed columns, so a removed
worker's token stops working at once, independent of whether its code is still
cached anywhere.

The platform authorises every `PAS` call by `ctx.props.appId` **and** the token;
both must match, and a call missing either is rejected. The token is a
**required factor, not defence in depth**: on the `account` and `dispatch`
backends, `props` lives in script metadata, and anyone holding a Workers-edit API
token on the shared Cloudflare account can rewrite that metadata — including the
`props` of another app's binding. `props` proves "the platform account configured
this", not "this is app X". The per-app token, which only the platform mints and
which is never shared between apps, is what binds a call to one app. (On the
`loader` backend the `LOADER` (`worker_loaders`) binding lives in
**`proappstore-api` itself**, so the `PAS` stub is created in-process from
`proappstore-api`'s own `ctx.exports.AppWorkerApi` with `props` set by platform
code at load time. The Dynamic Worker receives the stub, not the means to make
one, and no account metadata describes it, so those `props` cannot be forged or
re-pointed. The token is still required, so one authorisation rule holds on every
backend.)

### 3. Events, not routes, by default

App code is reached only through the shim (§1), and the shim accepts only a
signed **event envelope**, on every backend:

    POST /    X-PAS-Event-Signature: t=<unix seconds>,v1=<hex hmac-sha256>[,v1=<hex>]
    {
      "v": 1,
      "id": "<uuid>",               // idempotency key, stable across retries
      "app_id": "<id>",
      "type": "schedule" | "hook" | "http",
      "name": "<schedule or hook name>",
      "attempt": 1,
      "issued_at": <unix ms>,
      "caller": {                   // http only; absent on schedule and hook
        "grant_id": "<uuid>", "user_id": "<id>", "roles": ["..."],
        "exp": <unix s>, "sig": "<hex>"
      },
      "payload": { ... }            // schedule params, hook delivery, or request
    }

    // http payload (request; the response comes back in the same shape):
    "payload": { "method": "POST", "path": "/...", "query": "...",
                 "headers": { ... },              // allow-listed
                 "body": "<string>",
                 "body_encoding": "utf8" | "base64" }

`caller` is part of the signed body, so it is covered by the envelope signature
like every other field. The signature also covers the top-level `app_id`, and
the grant's own `sig` is computed over that `app_id` too (#260), so a `caller`
grant minted for one app cannot be replayed into another app's envelope.

- **Signature.** HMAC-SHA256 over `"<t>.<raw body>"` with `PAS_EVENT_KEY`,
  compared in constant time. The header may carry **several `v1=` values**; the
  shim accepts the envelope if any one verifies. During key rotation the
  platform signs with both the old and the new key, so a rotation never drops an
  event. Signing happens on **all** backends — `account`, `loader` and
  `dispatch` — so the shim and the SDK have one code path, and an envelope that
  reaches an app worker by any route is verifiable.
- **Freshness.** The shim rejects `|now − t| > 300 s` with `401`.
- **Replay and duplicates.** Delivery of `schedule` and `hook` events is
  **at-least-once**: a retry, a queue
  redelivery or a replay inside the 300 s window can deliver the same envelope
  twice. App handlers **must be idempotent on the envelope `id`**. The shim
  additionally de-duplicates ids it has already accepted within the window where
  the backend makes that feasible (an in-isolate cache is best-effort only —
  isolates are not shared; a platform-side record of delivered ids is
  authoritative), but handlers may not rely on it.
- **`http` events** (browser routes under `/.pas/worker/*`, proxied by the
  platform) carry a platform-minted, request-scoped caller grant in the top-level
  `caller` field (#260) so the worker may run actions *as that user* for the life
  of the request — never otherwise, and only actions whose `callers` includes
  `"user"`. The browser never reaches the app worker directly. `http` events are
  **not retried** — a browser request is not at-least-once — so they are the one
  exception to the delivery rule above.
- **Body encoding.** The envelope is JSON, which cannot carry arbitrary bytes. An
  `http` request or response body travels as `body` (string) plus
  `body_encoding`: `utf8` when the content type is textual (`text/*`,
  `application/json`, `*+json`, `application/x-www-form-urlencoded`) and the bytes
  are valid UTF-8, otherwise `base64`. The SDK rebuilds the exact bytes (#260).

### 4. Limits and abuse controls

- Per invocation: CPU 30 s; wall-clock bounded by the invoker (scheduled 5 min,
  http 30 s, hook — see below); `PAS` calls per invocation ≤ 200.
- **Two budgets, not one.** The 200 `PAS` calls are a **platform-side** budget,
  counted atomically on the per-invocation D1 record (an in-memory counter does
  not hold across isolates) (#254). The runtime `subRequests` limit (§5, §6 B.6)
  counts **every** subrequest — each `PAS` RPC **plus** every outbound `fetch`.
  So `subRequests` = `PAS` budget + an outbound budget, sized from duperdash's
  measured reconcile (#267). Setting `subRequests` to 200 starves any worker that
  calls out.
- **Hook budget.** Until queue delivery (#257) lands, a hook is acknowledged to
  the sender and then invoked from the request's `waitUntil`, which Cloudflare
  caps at 30 s after the response. Hook handlers therefore get **≤ 25 s**
  wall-clock (5 s headroom for the platform's own bookkeeping). When #257 moves
  hook delivery to a queue consumer, the budget may be raised and this ADR
  amended.
- `PAS.actions.batch`: ≤ 500 prepared statements per call (D1's 1,000
  queries-per-invocation on Workers Paid, halved for headroom), body ≤ 1 MB.
- Schedules: minimum interval 5 minutes (the platform tick), and every cron
  minute must be a multiple of 5, because the tick only ever lands on minutes
  0, 5, …, 55 and an off-tick minute would never fire (#281); ≤ 3 per app; the
  #123 five-failure breaker applies unchanged.
- Hooks: ≤ 10 per app, body ≤ 5 MB, verified by the platform before any app code
  runs, de-duplicated by delivery id.
- **Recording**, consistent with [ADR-008](./008-error-observability.md)'s
  two-tier split:
  - one **per-invocation record in D1** (app, event id, type, name, attempt,
    outcome, duration, `PAS` call count, error summary) — bounded and pruned on
    ADR-008's D1 retention, and counted against the app's log quota, so a
    misbehaving schedule cannot flood the shared `pas` database;
  - **per-`PAS`-call counts in Analytics Engine** (one data point per call,
    indexed by app, sampled as AE samples) — complete counting at no D1 cost.
  Individual `PAS` calls are **not** written to D1.

### 5. Three hosting backends behind one interface

    interface AppWorkerHost {
      deploy(appId, bundle): Promise<DeployResult>;
      invoke(appId, event): Promise<InvokeResult>;
      remove(appId): Promise<void>;
    }

`remove` runs when the app is deleted or its `app_workers_enabled` flag is turned
off: it deletes the script (`account`, `dispatch`) or the stored bundle
(`loader`), revokes the app's `PAS_WORKER_TOKEN` hashes (§2) and its event key,
and stops its schedules and hooks. After `remove`, no route reaches the app's code
and no `PAS` call from a still-cached isolate authorises. Turning the flag back on
does not restore anything: re-enabling requires a **fresh deploy** from the app's
main-branch workflow, which mints a new token and event key.

The backend is configuration (`APP_WORKER_BACKEND` = `account` | `loader` |
`dispatch`), not a code fork. All three run the same shim, the same signed
envelope and the same `PAS` contract.

- **`loader`** — Cloudflare [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
  (the Worker Loader binding). The platform stores the uploaded bundle and loads
  it on demand with
  `env.LOADER.get("<appId>:<bundleHash>:<configVersion>:<shimHash>", …)`, with
  the shim as `mainModule`. The ID **must** include more than the bundle hash:
  the loader caches by ID, and the `WorkerCode` behind an ID includes its `env`
  (`PAS_WORKER_TOKEN`, `PAS_EVENT_KEY`), the shim and the limits.
  `configVersion` is a per-app counter, bumped on every token or key rotation
  and every per-app env or limits change; `shimHash` is a build-time constant,
  the hash of the built shim plus the platform-set limits, so a platform deploy
  that changes either yields a new ID for every app. Otherwise a cached isolate
  keeps running with a revoked credential or an old shim. Per the Cloudflare docs, as read on 2026-10-01:
  - available on the **Workers Paid** plan, which PAS already uses — no new
    product purchase ([pricing](https://developers.cloudflare.com/dynamic-workers/pricing/));
  - billed per unique Dynamic Worker (Worker ID + code) per day — 1,000 included
    per month, then $0.002 per Dynamic Worker per day — plus requests and CPU at
    Workers Standard rates, where CPU includes isolate start-up. A stable ID per
    bundle and config version keeps an app at one billable worker per day
    ([pricing](https://developers.cloudflare.com/dynamic-workers/pricing/));
  - **no public URL**: a Dynamic Worker is reachable only through the stub the
    loader Worker obtains ([API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/));
  - **egress control** via `globalOutbound`: `null` cuts off `fetch()` and
    `connect()` entirely, or a `ctx.exports` gateway entrypoint intercepts every
    outbound request for allow-listing, credential injection and audit; the
    default, if unset, is full Internet access, so the platform must always set it
    ([egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/));
  - **capability passing**: `env` carries `ctx.exports` stubs with per-app
    `props` that only the loader sees and the Dynamic Worker cannot forge — the
    `PAS` binding is exactly this ([bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/));
  - **custom per-invocation `cpuMs` and `subRequests` limits**
    ([custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/));
  - a **concurrency cap**: at most 4 distinct Dynamic Workers in flight per Worker
    request, 10 per Durable Object
    ([limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/)).
    A scheduler tick cannot fan out to every app from one request; invocations
    must be spread across requests. A **queue consumer batch is one invocation**,
    so the cap applies to a batch too: a consumer either sets
    `max_batch_size` ≤ 4 or handles a batch's messages sequentially. #257 sets
    `max_batch_size = 1` (one message per consumer invocation), which satisfies
    both.
  - `get()` caches isolates by ID but guarantees nothing about reuse; the
    shim and app must not assume warm state.
  Not established by the docs and therefore **open for the spike**: whether
  `waitUntil` and scheduled-length wall-clock behave as for account scripts, how
  Tail-Worker logs map onto the per-invocation record, and the real CPU cost of
  isolate start-up for a typical app bundle.
- **`account`** — plain account scripts named `pas-app-<id>`, invoked over their
  public `workers.dev` URL with the signed envelope; the platform shim (§1) is
  the only thing standing between that URL and app code. It shares the account's
  500-script limit and has **no untrusted-code isolation** (an app worker can
  fetch any URL and is billed to the account; no custom CPU or subrequest
  limits).
- **`dispatch`** — a Workers for Platforms dispatch namespace in untrusted mode,
  invoked via `env.DISPATCHER.get(...)` with per-script custom limits and egress
  through an outbound worker. No public URL. Requires the WfP purchase.

**Sequencing.** #253 starts with a **time-boxed spike** evaluating `loader` as the
prototype backend. `loader` is preferred if viable, because it gives untrusted-code
isolation, egress control and custom limits **without** a public URL and
**without** a Workers for Platforms purchase. If the spike finds a blocker, the
prototype falls back to `account` + the shim. `dispatch` is phase 2 **only** if
`loader` does not cover what general availability needs.

**Prototype gate (any backend).** Until §6's criteria hold: an admin-set
`app_workers_enabled` flag per app, a hard cap of 5 app workers, and
**first-party apps only**. *First-party* means the app's owner is a platform
admin — their GitHub id is in `ADMIN_GITHUB_IDS`. #253 enforces this when the
flag is set: the flag cannot be turned on for an app whose owner is not an admin.

### 6. Exit criteria

Two separate gates.

**A. Purchase Workers for Platforms** (only if `loader` was found insufficient and
`dispatch` is needed), when all hold: (1) duperdash has run on PAS for ≥ 2 weeks
with scheduled syncs inside the breaker; (2) GitHub webhooks reach its dashboard
within ~1 minute; (3) **no Cloudflare token reaches any app repo** — measured
as **both** (a) `gh api orgs/proappstore-online/actions/secrets -q
'[.secrets[]|select(.visibility=="all")]|length'` → `0`, and no
`CLOUDFLARE_*`/`CF_API_*`/`R2_*` org secret whose `…/repositories` includes an
app repo, **and** (b) `gh secret list -R proappstore-online/<r>` shows no
`CLOUDFLARE_*`/`CF_API_*`/`R2_*` for every app repo (#274, #279; a per-repo
`gh secret list` alone does not see org secrets); (4) the pre-PAS duperdash is retired.

**B. Open app workers to all apps** (lift the flag, the cap and the first-party
rule), on whichever backend is then in use, when (1)–(4) hold **and**:

5. **egress control is enforced** — every app worker's outbound traffic goes
   through a platform gateway (`globalOutbound` on `loader`, an outbound worker on
   `dispatch`); `account` can never satisfy this, so it is never opened to all
   apps;
6. **custom CPU and subrequest limits are enforced** per invocation by the
   runtime, not only by the invoker's timeout;
7. **cross-app isolation tests pass** in CI — app A's worker cannot call `PAS`
   as app B (wrong token, wrong `props`, forged envelope), cannot read B's
   secrets, storage or logs, and cannot reach B's worker;
8. **a key-rotation drill has been done** — `PAS_EVENT_KEY` and
   `PAS_WORKER_TOKEN` rotated for a live app with dual-signing (§3) and no
   dropped event;
9. **per-app usage quotas are enforced** — metered invocations, CPU and hook
   volume per app, with daily quotas, so one app cannot exhaust the shared
   account's budget (#275).

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Keep the #147 rejection; extend SQL actions with an outbound-HTTP step | Turns the SQL action language into a workflow engine (auth, pagination, retries, JSON mapping) that is worse than the Worker runtime at all of them, and still gives no place for an inbound webhook's logic. |
| Let apps override `pas-data-<id>` (the doordrop pattern) | Already failed in production: the fleet redeploy restored the generic worker and nobody noticed for ten weeks. It also hands the app a raw D1 binding and the platform `SESSION_SIGNING_KEY`. |
| Apps deploy their own worker with their own Cloudflare token (the duperdash pattern) | A Cloudflare credential per app repo; no platform identity, data, secrets, schedules, audit or visibility. Nothing about it composes with PAS. |
| Give app workers direct D1/KV/R2 bindings | Bypasses the action lint (`:__user_id` scoping, schema coherence) and the audit trail; makes a later move to an isolated backend a security regression to undo. |
| Let app code verify envelopes itself (SDK helper only, no shim) | On `account` the script has a public URL; verification living in optional app code means one app that skips it is an unauthenticated entry point into platform-billed compute holding a `PAS` token. The shim makes verification unconditional. |
| Buy Workers for Platforms first | $25/mo before a single app has proven the shape — and Dynamic Workers (`loader`) may give the same isolation, egress control and limits on the Workers Paid plan PAS already has. WfP is bought only if the #253 spike shows `loader` cannot carry general availability (§6 A). |
| `account` as the only prototype backend | Public `workers.dev` URL, no isolation, no egress control, no custom limits, and it spends the 500-script limit. Kept only as the fallback if the `loader` spike fails. |
| A static service binding from the backend to each app worker | Bindings are declared at deploy time in `proappstore-api`'s config; per-app scripts are created at runtime. Not possible without redeploying the backend per app. (`loader` avoids this: one `worker_loaders` binding loads any app's code at runtime.) |

## Consequences

**Positive:**
- Apps gain scheduled jobs that can call out, inbound webhooks and connectors,
  while data still flows only through linted actions.
- No Cloudflare credential reaches any app repo (once #274 closes — a
  precondition, not a consequence); the doordrop/duperdash hacks retire.
- Envelope verification is enforced by platform code on every backend, not left
  to each app.
- If the `loader` spike succeeds, the prototype already has isolation, egress
  control and custom limits with no new purchase and no public URL.

**Negative:**
- If the prototype falls back to `account`, it runs app code in the platform
  account without isolation; only the shim, the flag, the cap and first-party
  ownership contain it, and it consumes the shared 500-script limit.
- `loader` adds per-day Dynamic Worker charges and start-up CPU billing, and its
  4-per-request concurrency cap shapes how the scheduler fans out.
- A new invocation path (event envelope, per-app keys, dual-signing rotation) to
  secure and operate; handlers must be written idempotently.

**Neutral:**
- The single control plane in [Architecture](../architecture.md) is unchanged:
  identity, data, secrets and scheduling stay in `proappstore-api`; app workers
  are its tenants.
