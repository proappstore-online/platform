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
| **Agent build/deploy failures** | agent-teams activity log | `agent_activity` MCP tool |
| **Alerts** (spikes detected from the rows above) | `app_alerts` (#107) | `GET /v1/apps/:appId/alerts` (owner) — the console's per-app workspace; `open=1` for unacknowledged |

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

## Alerts (automated — #107)

The backend cron (`*/15`, `index.ts` `scheduled`) runs `lib/error-alerts.ts`
`evaluateErrorSpikes` over the signals above and records one `app_alerts` row
per app, kind and 15-minute window (a re-run never doubles an alert). Kinds and
the implemented thresholds:

| Kind | Source rows | Fires when |
|---|---|---|
| `error_spike` | `app_logs` `level = 'error'`, client-sourced | ≥ 20 in the window **and** ≥ 3× the previous window |
| `action_failures` | `app_logs` `source = 'server'`, `category = 'action'` | ≥ 20 in the last 5 minutes (the "> 20 / 5 min" rule above) |
| `server_5xx` | `app_logs` `source = 'server'`, `level = 'error'` (backend 5xx recorded by the operation-log hook) | ≥ 5 in the window ("sustained") |
| `qa_failures` | `app_test_runs`, deploy/cron triggers | ≥ 2 consecutive failed runs with no pass since (the "2+ consecutive" rule; live now that #62 fixed stuck runs) |

The runbook's "5% of a route's sessions" is not computed yet (it needs session
counts joined to routes); the absolute-plus-jump rule above is the starting
point — tune the constants at the top of `lib/error-alerts.ts`.

**Payload** (`GET /v1/apps/:appId/alerts`): app id, kind, window, count,
affected users (a count of distinct sessions or anonymous client ids), the
previous window's baseline, top categories / operations / fingerprints, and the
latest build metadata seen in the window. Never a log message, request body,
token, credential or user id.

**Where it goes**: the console (pull — ADR-008 decision 6). Owners who want a
push receive the same payload on a registered webhook for event `app.alert`
(`POST /v1/apps/:appId/webhooks`, HMAC-signed by `lib/webhook-dispatch.ts`);
nothing is sent unless one exists. `POST /v1/apps/:appId/alerts/evaluate` runs
the evaluation for one app on demand; `POST …/alerts/:id/ack` acknowledges.
Every recorded alert is also a `[alert] …` line in Workers Logs.

**Not automated**: the "5% of sessions" rate; data-worker 5xx (they are not in
`app_logs` — see Workers logs); cross-app platform-wide spikes (each alert is
per app).
