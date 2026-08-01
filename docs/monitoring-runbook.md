# Operational Monitoring & Runbook

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

## Remaining automation (not yet built — #107)
The **alerting cron** is the open slice: a scheduled Worker that aggregates
`app_logs` error rates + backend 5xx per app over a rolling window, compares to
the thresholds above, and notifies the owner/platform on a spike (email/webhook).
Until it ships, monitoring is **pull** (query the signals above); this runbook is
the manual path. When built, it should reuse `app_logs` (now the durable client
signal) as the source of truth and dedupe alerts per (app, category, window).
