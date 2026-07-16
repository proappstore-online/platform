# Publishing flow

`pas publish` calls `POST /v1/provision` on the PAS backend
(`api.proappstore.online`). The PAS platform owns the full publish flow —
no delegation to FAS or any other store's admin.

## End-to-end sequence

```text
publisher                  PAS backend (api.proappstore.online)
  |                                       |
  |-- pas publish (/v1/provision) ------> |
  |   (metadata)                          |
  |                                       |-- 1. Validate app id
  |                                       |-- 2. Compliance check (fetch repo from GitHub, run checks)
  |                                       |-- 3. Register R2 host route (D1 routes table — Path B, no CF Pages)
  |                                       |-- 4. Create per-app D1 database `pas-data-{id}`
  |                                       |-- 5. Deploy `data-{id}.proappstore.online` worker
  |                                       |-- 6. Insert app record (platform apps table)
  |                                       |
  | <---- result + URL ---------------    |
  |
  +-- register mcp.json tools (PUT /v1/apps/{id}/tools) + dispatch R2 deploy-secret reconcile
  |
  +-- git push origin main
     GitHub Actions deploy (keyless OIDC), in order:
       build -> migrate (migrations.json) -> upload to R2 -> register mcp.json tools
```

The deploy order matters: `migrations.json` is applied to D1 **before** the new
frontend uploads and **before** `mcp.json` tools register, so a registered action
never references a column that isn't there yet (§10; see
`app-actions-security.md`). The migrate step is hard-gated — a migration failure
fails the deploy. Additive-only (`CREATE`/`ALTER … ADD`/`INSERT`); destructive
SQL is rejected with 422.

## Key properties

- **Standalone.** The PAS backend has its own Cloudflare/GitHub credentials for
  R2 host routes, D1, data-worker deploys, and repo setup. No cross-store service
  bindings.
- **Idempotent.** Re-running on a partially-provisioned app fills in only missing pieces.
- **CLI-driven.** `pas publish` is the intended entrypoint; it calls
  `POST /v1/provision`. Each subsequent `git push` runs the keyless deploy, which
  applies `migrations.json` then re-registers `mcp.json` app tools (both when present).

## Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| `repo already exists` | Retry after partial failure | Safe if state matches; otherwise abort |
| Compliance `412` | A hard compliance rule failed on the fetched repo | Fix the flagged rule and re-run; the step lists each failure |
| `D1 quota exceeded` | Account-level D1 limit reached | Block provisioning, alert |

## Testing

PAS provisioning has vitest suites mocking the GitHub + CF APIs. Run `pnpm test`
in `packages/backend/` (the `/v1/provision` route) and `packages/admin/` (the
shared `provisionApp` / `runProvisionSteps` core).
