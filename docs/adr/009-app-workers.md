# ADR-009: App workers — platform-hosted, sandboxed per-app server code

## Status

**Accepted** (2026-10). Supersedes the option-1 rejection recorded in platform#147
("general per-app Worker cron: rejected for now"). Refines ADR-003: one control
plane still owns identity, data, secrets and scheduling; app workers are tenants of
it, not a second control plane. Tracked by platform#251.

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

## Decision

### 1. An app may own one *app worker*, deployed and invoked only by the platform

- The bundle is built in the app repo (`worker/`) and uploaded **through the
  platform**, authenticated by GitHub Actions OIDC exactly like
  `deploy-credentials`, `tools/oidc` and `migrate/oidc`. **No Cloudflare
  credential ever lives in an app repo.**
- The platform constructs the script metadata (bindings, compatibility date,
  limits). App code cannot add, remove or alter a binding.
- The app worker is a separate script from the data worker. Platform redeploys of
  `pas-data-<id>` never touch it, and it can never replace `pas-data-<id>`.

### 2. Sandbox contract

An app worker receives **exactly**:

| Binding | What it is |
|---|---|
| `PAS` | service binding to `proappstore-api`, RPC entrypoint `AppWorkerApi`, with platform-set `props: { appId }` |
| `PAS_WORKER_TOKEN` | per-app secret; second factor on every `PAS` call |
| `PAS_EVENT_KEY` | per-app HMAC key; verifies event envelopes (account backend only) |
| `APP_ID` | plain text |

It receives **no** D1, KV, R2, Durable Object, Queue or AI binding, and **no** app
secret as an environment variable. Data goes through `PAS.actions.*` (registered,
linted SQL — the same actions every other caller uses); secrets through
`PAS.secrets.get(name)`, which returns only secrets the manifest declares for the
worker; files through `PAS.storage.*`; logs through `PAS.log`.

The platform authorises every `PAS` call by `ctx.props.appId` **and** the token.
`props` is authoritative because only the platform writes script metadata; the
token stays as defence in depth and is the sole proof if `props` is ever
unavailable on a backend.

### 3. Events, not routes, by default

An app worker is invoked by the platform with a signed **event envelope**:

    POST /  (account backend)    X-PAS-Event-Signature: t=<unix>,v1=<hex hmac-sha256>
    {
      "v": 1,
      "id": "<uuid>",               // idempotency key
      "app_id": "<id>",
      "type": "schedule" | "hook" | "http",
      "name": "<schedule or hook name>",
      "attempt": 1,
      "issued_at": <unix ms>,
      "payload": { ... }            // hook body, schedule params, or request
    }

The signature is HMAC-SHA256 over `"<t>.<raw body>"` with `PAS_EVENT_KEY`; the
worker rejects a bad signature or `|now - t| > 300 s`. The SDK helper does this, so
app code only sees verified events. `http` events (browser routes under
`/.pas/worker/*`) carry a platform-minted, request-scoped caller grant so the worker
may run actions *as that user* for the life of the request — never otherwise.

### 4. Limits and abuse controls

- Per invocation: CPU 30 s; wall-clock bounded by the invoker (scheduled 5 min,
  hook 60 s, http 30 s); `PAS` calls per invocation ≤ 200.
- `PAS.actions.batch`: ≤ 500 prepared statements per call (D1's 1,000
  queries-per-invocation on Workers Paid, halved for headroom), body ≤ 1 MB.
- Schedules: minimum interval 5 minutes (the platform tick), ≤ 3 per app; the
  #123 five-failure breaker applies unchanged.
- Hooks: ≤ 10 per app, body ≤ 5 MB, verified before any app code runs,
  de-duplicated by delivery id.
- Every invocation and every `PAS` call is recorded against the app (run history,
  delivery log, `app_logs`).

### 5. Two hosting backends behind one interface

    interface AppWorkerHost {
      deploy(appId, bundle): Promise<DeployResult>;
      invoke(appId, event): Promise<InvokeResult>;
    }

- **`account`** (prototype): plain account scripts named `pas-app-<id>`, invoked
  over their workers.dev URL with the signed envelope. It shares the account's
  500-script limit and has **no untrusted-code isolation** (an app worker can
  fetch any URL and is billed to the account). It is therefore gated: an
  admin-set `app_workers_enabled` flag per app, a hard cap of 5 `pas-app-*`
  scripts, first-party apps only.
- **`dispatch`** (general availability): a Workers for Platforms dispatch
  namespace in untrusted mode, invoked via `env.DISPATCHER.get(...)` with
  per-script custom limits, egress through an outbound worker. The event
  envelope is still signed; the token check stays.

The backend is configuration (`APP_WORKER_BACKEND`), not a code fork.

### 6. Exit criteria for `account` → `dispatch`

Workers for Platforms is purchased, and the flag/cap lifted, only when all hold:
(1) duperdash has run on PAS for ≥ 2 weeks with scheduled syncs inside the
breaker; (2) GitHub webhooks reach its dashboard within ~1 minute; (3) no app repo
holds a hand-placed Cloudflare token; (4) the pre-PAS duperdash is retired.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Keep the #147 rejection; extend SQL actions with an outbound-HTTP step | Turns the SQL action language into a workflow engine (auth, pagination, retries, JSON mapping) that is worse than the Worker runtime at all of them, and still gives no place for an inbound webhook's logic. |
| Let apps override `pas-data-<id>` (the doordrop pattern) | Already failed in production: the fleet redeploy restored the generic worker and nobody noticed for ten weeks. It also hands the app a raw D1 binding and the platform `SESSION_SIGNING_KEY`. |
| Apps deploy their own worker with their own Cloudflare token (the duperdash pattern) | A Cloudflare credential per app repo; no platform identity, data, secrets, schedules, audit or visibility. Nothing about it composes with PAS. |
| Give app workers direct D1/KV/R2 bindings | Bypasses the action lint (`:__user_id` scoping, schema coherence) and the audit trail; makes the dispatch move a security regression to undo later. |
| Buy Workers for Platforms first | $25/mo before a single app has proven the shape. The account backend uses the same upload format, so the prototype is not throwaway. |
| A static service binding from the backend to each app worker | Bindings are declared at deploy time in `proappstore-api`'s config; per-app scripts are created at runtime. Not possible without redeploying the backend per app. |

## Consequences

**Positive:**
- Apps gain scheduled jobs that can call out, inbound webhooks and connectors,
  while data still flows only through linted actions.
- No Cloudflare credential in any app repo; the doordrop/duperdash hacks retire.
- The prototype costs nothing new and migrates to dispatch by re-upload.

**Negative:**
- The `account` backend runs app code in the platform account without isolation;
  only the flag, the cap and first-party ownership contain it.
- `pas-app-*` scripts consume the shared 500-script limit until phase 2.
- A new invocation path (event envelope, per-app keys) to secure and rotate.

**Neutral:**
- ADR-003's single control plane is unchanged: identity, data, secrets and
  scheduling stay in `proappstore-api`; app workers are its tenants.
