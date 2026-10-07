# App workers

An app worker is the app's own server code: one Worker per app, deployed and
invoked by the platform, for the work a browser cannot do — a scheduled sync with
GitHub, a webhook from Stripe, a server-side route that holds an API key. The
design and its constraints are [ADR-009](./adr/009-app-workers.md); this page is
the developer reference.

::: warning Prototype
App workers run only for apps a platform admin has enabled (at most 5, first-party
apps only), and no production app is enabled yet. Deploys for any other app are
refused with `403 app workers are not enabled for this app`.
:::

## What the worker is

- **Code in `worker/`, built to `worker/dist/app.js`.** `pas create <id> --with-worker`
  adds the scaffold. On push to `main` the app's deploy workflow builds it and
  uploads the modules to the platform with GitHub OIDC — no Cloudflare credential
  is involved. An app without `worker/package.json` skips the step.
- **The platform owns the entry point.** It uploads its own entry shim beside your
  modules. The shim verifies the signature on every event (HMAC-SHA256, ±300 s) and
  only then imports `app.js`; an unsigned request gets `401` and none of your code
  runs, not even module top level.
- **No URL of its own.** The worker is reached only through platform events:
  `schedule`, `hook` and `http` (below).

## Sandbox contract

The worker receives exactly these bindings (ADR-009 §2):

| Binding | What it is |
|---|---|
| `PAS` | RPC to the platform API: `actions`, `secrets`, `storage`, `log` |
| `PAS_WORKER_TOKEN` | per-app token, required on every `PAS` call (the SDK passes it) |
| `PAS_EVENT_KEY` | per-app HMAC key the shim verifies events with |
| `APP_ID` | the app id |

There is **no** D1, KV, R2, queue or AI binding, and no app secret in `env`:

- **Data** goes through your registered actions — the same linted SQL every
  other caller uses — and only actions whose `callers` include `"worker"`.
- **Secrets** come from `pas.secrets.get(name)`, and only for names listed in
  `worker.secrets`.
- **Files** go to `pas.storage`, under `<app>/_worker/<key>`, never a user's files.
- **Logs** go to `pas.log`, into the app's logs with category `worker`.
  Plain `console.log` / `console.error` output and uncaught exceptions land
  there too (source `worker-console`), delivered by the platform's Tail Worker
  (`AppWorkerTail`, #308) after each invocation: at most 100 lines per
  invocation, within the worker's own log budget (below).

Outbound `fetch` to the Internet works: it leaves through the platform's egress gateway (`AppWorkerEgress`, #311), which logs the app, method and host.

## Manifest (`mcp.json`)

```json
{
  "tools": [
    {
      "name": "upsert_repo", "description": "Worker: record a repo", "operation": "execute",
      "sql": "INSERT INTO repos (id, name, synced_at) VALUES (:id, :name, :__now) ON CONFLICT(id) DO UPDATE SET name = excluded.name, synced_at = excluded.synced_at",
      "params": { "id": { "type": "integer" }, "name": { "type": "string" } },
      "requires_auth": true,
      "auth": { "caller_unscoped": { "reason": "the sync writes every repo" } },
      "callers": ["worker"]
    }
  ],
  "worker": {
    "secrets": ["GITHUB_TOKEN"],
    "schedules": [{ "name": "reconcile", "cron": "*/15 * * * *", "params": { "full": false } }]
  },
  "hooks": [
    { "name": "github", "verify": { "kind": "github-hmac-sha256", "secret": "GITHUB_WEBHOOK_SECRET" }, "to": "worker" }
  ],
  "visibility": { "mode": "private", "roles": ["viewer"] }
}
```

### `callers` (per action)

Who may run the action: any of `"user"`, `"worker"` and `"hook"`. The default is
`["user"]`, so existing actions behave as before.

- An action whose `callers` lacks `"user"` is refused on the HTTP actions route
  and hidden from the app's MCP tools. A worker-only or hook-only write can never
  be called by a signed-in user.
- A worker or hook runs as `system:worker` or `system:hook`. Neither identity holds
  any role, so a role-gated action never runs for them. An authenticated statement
  without `:__user_id` needs `auth.caller_unscoped` with a reason.
- Scheduled actions cannot declare `callers`: only the platform scheduler runs them.

### `worker`

| Field | Meaning |
|---|---|
| `secrets` | App secret names the worker may read with `pas.secrets.get`. Set values with `pas secret set NAME`. |
| `schedules` | Up to **3** entries of `{ name, cron, params? }`. `name` matches `[a-z][a-z0-9_]{0,49}`. `cron` is five-field UTC, and every minute must be a multiple of 5 (the platform ticks every 5 minutes). `params` is at most 4 KB of JSON and arrives as `event.payload`. |

### `hooks`

Up to **10** entries of `{ name, verify, to }`. Each hook gets a public URL:

    POST https://api.proappstore.online/v1/apps/<app>/hooks/<name>

`verify.kind` is the scheme the platform checks **before** any of your code runs:

| Kind | Checks | De-duplicated on | Shown as the delivery id |
|---|---|---|---|
| `github-hmac-sha256` | `X-Hub-Signature-256` | the body's SHA-256 | `X-GitHub-Delivery` |
| `stripe` | `Stripe-Signature` (timestamped, 5 min tolerance) | the event `id` in the signed body | the event `id` |
| `hmac-sha256` | a hex or base64 HMAC of the body in a header you name (`header`, `prefix`, `encoding`) | the body's SHA-256 | `id_header`, if set |
| `secret-token` | `X-PAS-Hook-Token` equals the secret | the body's SHA-256 | `id_header`, if set |
| `github-app` | fed by the platform's GitHub App (see `connectors`), not a public URL; it has no `secret` | the body's SHA-256 | `X-GitHub-Delivery` |

`verify.secret` names the app secret holding the shared secret. If the secret
is not set, every delivery is refused with `401`. `pas hook list` shows
`MISSING` for it.

`to` is `"worker"`, which delivers the hook to the worker's `webhook` handler.
It can instead be `{ "action": "<name>", "params": { … } }`, which runs one
`execute` or `batch` action as `system:hook`. Each param is either a literal or
a path into the JSON body (`$.repository.id`, `$.items[0]`). The action must list
`"hook"` in `callers`, require auth, declare `caller_unscoped` with a reason, and
have no role gate.

**Replay protection (#317).** A delivery is de-duplicated on a key taken only
from bytes the signature covers: the SHA-256 of the verified body, or, for
Stripe, the event id inside the signed body. A delivery-id header such as
`X-GitHub-Delivery` or your `id_header` is not signed. It is shown in
`pas hook deliveries` and `GET …/hook-deliveries` (`delivery_id`, next to
`replay_key`), and nothing else depends on it. So someone who has seen a signed
delivery cannot get it run again by changing its headers.

- Repeating a delivery that was received or delivered answers
  `200 {"duplicate": true}`, whatever its headers say. That includes the
  sender's own retries.
- Repeating one that failed runs it again as the next attempt. This is how
  GitHub "Redeliver" and Stripe "Resend" work.
- Two deliveries with different bodies are two deliveries, even under the same
  delivery id.
- Two deliveries with byte-identical bodies are one delivery. Real events
  differ, but if your sender can emit the same body twice for two events, put
  something unique (an id or a timestamp) in the body.
- **The window is 14 days**, the retention of the delivery log. After that, a
  captured delivery from a sender without a signed timestamp (every kind but
  `stripe`) could be accepted once more. Stripe's 5-minute signature tolerance
  closes that window.
- `secret-token` proves only that the sender knows the token, not that the body
  is theirs: anyone holding the token can send any body. Prefer an HMAC kind
  where the sender supports one.

The sender gets `202` as soon as the delivery is verified and recorded.

A hook for the worker is delivered from a queue, with retries: if the worker does
not answer 2xx, the platform tries again after 20, 40, 80, 160 and 320 seconds,
each time with `attempt` one higher and the same `id`. After the last retry the
delivery is `failed` (`dead-lettered after 6 attempts`) and is not replayed
automatically; redeliver it from the sender. A schedule run is retried the same
way, stays `queued` while it is, and counts one failure toward the breaker only if
every attempt fails.

**Recovery from cut-off processing (#319).** A delivery is recorded `received`
before it is processed. Processing can be cut off: an action hook runs after the
response, which Cloudflare ends 30 s later, and an isolate can be evicted at any
time. Each attempt therefore holds a processing lease:

| Target | Lease | Why |
|---|---|---|
| `{ "action": … }` | 5 minutes | the action runs within the 30 s after the response |
| `"worker"` | 60 minutes | the queue's retries and dead-lettering end within about 16 minutes |

While its lease runs, a `received` delivery is in progress: a repeat answers
`{"duplicate": true}`. Once the lease has passed it is stale:

- **A redelivery takes it over.** Exactly one, even when several arrive at once:
  the takeover is one conditional update, which only the first matches, under a
  fresh lease. The delivery runs again as the next attempt and counts toward
  `hook_deliveries` like any retry. A late finish of the cut-off attempt cannot
  overwrite the new one.
- **The platform's 5-minute tick fails it** when no redelivery comes. Its error
  is `processing was cut off and never finished (lease expired)`, so it shows
  in `pas hook deliveries --status failed`. Redeliver it from the sender.
- A `delivered` delivery is always a duplicate, however old.

Hooks are at-least-once. An attempt cut off after its action or worker had
already acted, but before the platform recorded it, runs again on takeover.
Handlers must be idempotent on the delivery, as they already must be for
retries.

The same tick also ends **invocations** left `running` for more than 10
minutes (the longest budget is a schedule's 5): they become `timeout`, with an
`abandoned` error. From then on their `PAS` calls and caller grant are refused.

Delivery rows are kept 14 days and invocation rows 30 days.

### `visibility`

`{ "mode": "private", "roles": [...] }` gates the whole app, including
`/.pas/worker/*`, to its team and the listed roles. See
[MCP app tools](./mcp-app-tools.md#private-apps-visibility).

### `connectors`

```json
"connectors": [ { "name": "github", "kind": "github", "modes": ["app", "pat"], "pat_secret": "GITHUB_TOKEN",
                  "events": ["issues", "workflow_run", "deployment_status", "check_suite"], "hook": "github" } ],
"hooks": [ { "name": "github", "verify": { "kind": "github-app" }, "to": "worker" } ]
```

`modes` is `app` (the platform's GitHub App, installed on an account whose owner
or admin approves it), `pat` (an app secret you set, named by `pat_secret`), or
both. `events` are the GitHub events delivered to the `hook`, which must use
`verify.kind: "github-app"`; the platform receives every App webhook on one
endpoint and routes it by installation, so you configure nothing per repo.

Connect an installation from the console (owner only). The platform proves you
control the installation through GitHub before binding it; a non-admin org member
cannot. Then, in the worker:

```ts
await pas.connectors.token('github', { repo: 'org/name' });   // installation token scoped to that repo, else the PAT, else null
await pas.connectors.token('github', { mode: 'pat' });        // always the PAT
```

Installation tokens are short-lived and repo-scoped. They are not user tokens:
`viewer` and `@me` queries need `mode: 'pat'`. `mode: 'app'` never falls back to
the PAT. Until the platform's GitHub App is configured, the connect routes answer
`503 connector not configured`; `pat` mode needs only the app secret.

## The SDK: `@proappstore/sdk/worker`

```ts
import { defineAppWorker } from '@proappstore/sdk/worker';

export default defineAppWorker({
  async scheduled(event, pas) { /* event.name is the schedule, event.payload its params */ },
  async webhook(event, pas) { /* event.hook.headers, event.hook.body (exact bytes) */ },
  async fetch(request, pas) { return Response.json({ ok: true }); },
});
```

Every handler receives the event, plus a `pas` client bound to this invocation:

| Call | Does |
|---|---|
| `pas.actions.call(name, params?)` | Runs one registered action. |
| `pas.actions.batch([{ name, params }])` | Runs many actions in one transaction, at most 500 statements and 1 MB. It counts as one `PAS` call. |
| `pas.secrets.get(name)` | Returns a secret listed in `worker.secrets`, otherwise `null`. |
| `pas.storage.put(key, body, { contentType? })` / `get(key)` | Reads and writes worker files, at most 10 MB each. |
| `pas.log(level, message, fields?)` | Appends to the app's logs. Resolves `false` when the worker's daily log budget is spent (the line is dropped; the invocation carries on). |

`event` is `{ id, type, name, attempt, issuedAt, payload }`. For a hook it also
carries `hook: { headers, body }`. `hookBody(payload)` decodes an envelope body
back to bytes.

### `fetch`: browser routes

A request from the app's own page to `/.pas/worker/<path>` reaches `fetch` as a
standard `Request`:

- **Who:** signed-in users only, with the same CSRF rules as `/.pas/api`.
- **Request:** at most 1 MB. It is never retried.
- **Actions:** inside the request, `pas.actions` run **as that user**, with their
  rows and their role gates. The platform passes a 30-second caller grant for
  this. Only actions whose `callers` include `"user"` can run this way. The
  grant works only inside the request it came with (#318). It must be used with
  that request's own invocation, which the SDK passes for you, while the request
  is running. Keeping it for a later request, a schedule or a hook gets
  `Unauthorized`.
- **Response:** only `Content-Type` and `ETag` pass through, and
  `Cache-Control` is always `private, no-store`.

```ts
// web: const res = await fetch('/.pas/worker/v1/report', { credentials: 'include' });
// SDK: await pro.worker.fetch('/v1/report')
```

## Delivery is at least once

`schedule` and `hook` events can arrive more than once: a retry, a redelivery, or
a replay inside the signature window. **Make every handler idempotent on
`event.id`.** The `id` stays the same across retries.

- Write with `INSERT … ON CONFLICT DO UPDATE` or a uniqueness check.
- Never write with a blind `INSERT` or an increment.

`http` events are the exception: they are never retried.

## Limits

| Limit | Value |
|---|---|
| CPU per invocation | 30 s |
| Wall clock | schedule 5 min · http 30 s · hook 60 s (delivered by a queue after the `202`) |
| `PAS` calls per invocation | 200, counted on the platform side. Outbound `fetch` counts toward the runtime subrequest limit, not this budget. |
| `PAS.actions.batch` | 500 statements, 1 MB body |
| Schedules | ≤ 3 per app, ≥ 5 min apart, minutes on the 5-minute tick |
| Schedule failures | 5 in a row disable the schedule and raise one alert. Redeploying the manifest re-enables it. |
| Run now | one manual run per schedule per minute; it is queued at once (status `queued`) |
| Hooks | ≤ 10 per app, body ≤ 5 MB |
| Worker files | 10 MB per object |
| Invocation history | 30 days; hook deliveries 14 days |

**Worker logs have their own budget (#316).** `pas.log` lines and console
output count against a worker log budget of 50,000 lines per app per UTC day.
That counter is `log_entries` on `GET /v1/apps/:id/worker/usage`, and the
limit is `worker_log_limit`. It is separate from the app's log quota, which the
app's browser clients and anonymous log ingestion spend. Over the budget, lines
are dropped and `pas.log` resolves `false`. Nothing else changes: the
invocation runs, a schedule run still succeeds, and no breaker counts it.

Logging never decides whether your worker runs. A flood of anonymous log
batches against your app, or a chatty worker of your own, can use up a log
budget, but only `invocations`, `cpu_ms` and `hook_deliveries` (below) can stop
an invocation. Log a summary per run, not a line per item, to keep your lines
inside the budget.

## Daily quotas

Each app has a usage quota per UTC day (#275). The quota is checked before any
work starts, and usage resets at 00:00 UTC.

| Quota | Default | Counts |
|---|---|---|
| `invocations` | 5,000 | every invocation: schedule runs, hook deliveries to the worker, and `/.pas/worker/*` requests |
| `cpu_ms` | 3,600,000 (1 h) | wall-clock time of invocations, labelled `cpu_ms_source: "wall"`. A proxy known when the invocation returns; the worker's real CPU time is recorded per invocation (below) but not metered |
| `hook_deliveries` | 2,000 | verified, non-duplicate deliveries to any hook (worker or action) |

The defaults are provisional: they will be revisited with measured usage before
app workers open to all apps. A platform admin can raise one app's quotas with
`PUT /v1/admin/apps/:id/worker-quotas`.

What happens over quota:

- **Schedule:** the run fails with `quota exceeded`. It counts toward the
  five-failure breaker.
- **Hook:** the sender still gets `202`. The delivery is recorded with
  `status: "quota_exceeded"`, and no app code runs.
  **Events over quota are recorded but not processed. Redeliver them from the
  sender after 00:00 UTC**: GitHub's *Redeliver*, or Stripe's *Resend*. A
  redelivery of a `quota_exceeded` delivery is accepted like a failed one. The
  hook answers `202` and not `429` because GitHub never redelivers on its own,
  so a `429` would lose the event just the same.
- **Browser request:** `429` with `Retry-After` set to the seconds until 00:00
  UTC.
- **Quota check fails:** if the check itself cannot run, nothing runs. The
  delivery or run is recorded as `failed` with `quota check unavailable`, and a
  browser request gets `503`.

At 80 % of any quota, the app gets one `app_worker_quota` alert and one
`app.alert` webhook per day. `pas worker status` shows today's usage against the
quotas, and `GET /v1/apps/:id/worker/usage?days=30` returns the history.

Above a platform-wide daily ceiling, the platform stops enabling app workers for
new apps until an admin reopens it. Apps already running are not affected.

## Operating it

The owner commands use your `pas login` session:

```bash
pas worker status                       # enabled, today's usage vs quota, last deploy, schedules (and breaker state), recent invocations
pas worker logs --since 10m [--follow]  # PAS.log lines + invocation outcomes
pas worker rotate                       # new token + event key; the old pair works for 10 more minutes
pas schedule runs [--status failed]     # scheduled-action and worker-schedule runs
pas schedule run reconcile              # queue a worker schedule now (202)
pas hook list                           # each hook's URL, verifier, and whether its secret is set
pas hook deliveries github --status failed
pas secret set GITHUB_TOKEN             # hidden prompt; or: … | pas secret set NAME --stdin
```

The same data is available over HTTP (owner session):

- `GET /v1/apps/:id/worker`
- `GET /v1/apps/:id/worker/usage?days=30`
- `GET /v1/apps/:id/scheduled-runs`
- `GET /v1/apps/:id/hooks`
- `GET /v1/apps/:id/hook-deliveries`
- `GET /v1/apps/:id/logs?category=worker`
- `GET /v1/apps/:id/logs?trace_id=<invocation id>`

### One invocation, end to end (#308)

Every invocation has an id, `<event id>:<attempt>`: the `id` of its
`app_worker_invocations` record. That id ties together:

- **Platform logs.** Workers Logs has two `[app-worker]` lines for it, one
  `invoke <app> <type> [<name>] <id>` and one `<id> <status> [<http status>] <ms>`.
- **Your worker's logs.** Every `pas.log` line and every `console` line or
  exception from that invocation has `traceId` = the id. Fetch them with
  `GET /v1/apps/:id/logs?trace_id=<id>`.
- **CPU.** After the invocation ends, the Tail Worker fills `child_cpu_ms`,
  `child_wall_ms` and `child_outcome` on the record (`ok`, `exception`,
  `exceededCpu`, …). `child_cpu_ms` is your worker's own `cpuTime`. It excludes
  module start-up, which the runtime does not report. Until the trace arrives,
  the three fields are `null`.

No route ever returns a secret value, the worker token or the event key.

## Recipe: keep a table in sync with GitHub

1. Run `pas secret set GITHUB_TOKEN` and paste a fine-grained token with read
   access.
2. Run `pas secret set GITHUB_WEBHOOK_SECRET`. Use the same value in the GitHub
   webhook settings, with Payload URL `https://api.proappstore.online/v1/apps/<app>/hooks/github`
   and content type `application/json`.
3. Write the manifest shown above: a worker-only `upsert_repo` action,
   `worker.secrets`, a `reconcile` schedule, and a `github` hook to the worker.
4. Add the worker with `pas create <app> --with-worker` for a new app. For an
   existing one, copy `worker/` from a new scaffold and add `- worker` to
   `pnpm-workspace.yaml`.

```ts
import { defineAppWorker, type PasClient } from '@proappstore/sdk/worker';

async function upsert(pas: PasClient, repos: { id: number; full_name: string }[]) {
  // Idempotent on the repo id: a redelivered event rewrites the same rows.
  await pas.actions.batch(repos.map((r) => ({ name: 'upsert_repo', params: { id: r.id, name: r.full_name } })));
}

export default defineAppWorker({
  async scheduled(event, pas) {
    const token = await pas.secrets.get('GITHUB_TOKEN');
    const res = await fetch('https://api.github.com/user/repos?per_page=100', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'my-app' },
    });
    if (!res.ok) throw new Error(`github ${res.status}`); // a failed run; 5 in a row disable the schedule
    const repos = (await res.json()) as { id: number; full_name: string }[];
    await upsert(pas, repos);
    await pas.log('info', 'reconciled', { count: repos.length, run: event.id });
  },
  async webhook(event, pas) {
    if (event.hook?.headers['x-github-event'] !== 'repository') return;
    const body = JSON.parse(new TextDecoder().decode(event.hook.body)) as { repository: { id: number; full_name: string } };
    await upsert(pas, [body.repository]);
  },
});
```

5. Push to `main`, then check the result:
   - `pas worker status` shows the deploy.
   - `pas schedule run reconcile` queues a first sync, and
     `pas schedule runs` shows it.
   - `pas hook deliveries github` shows GitHub's ping.

For a simple mapping, skip the worker: a hook can go straight to an action with
`"to": { "action": "upsert_repo", "params": { "id": "$.repository.id", "name": "$.repository.full_name" } }`.
The action then needs `"callers": ["hook"]`.
